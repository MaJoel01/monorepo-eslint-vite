import express from "express";
import { fileURLToPath } from "url";
import fs from "fs";
import { dirname, join } from "path";
import { createRequire } from "module";
import cors from "cors";
import { createOpenAI } from "@ai-sdk/openai";
import { InvalidArgumentError } from "@ai-sdk/provider";
import { delay as originalDelay } from "@ai-sdk/provider-utils";
import type { TextStreamPart, ToolSet } from "ai";
import { convertToCoreMessages, generateText, streamText } from "ai";
import {
  createServerProtocolHandler,
  createLspInMemoryEnvironment,
} from "@lix-js/sdk";
import dotenv from "dotenv";

dotenv.config();
const require = createRequire(import.meta.url);

// Define __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const node_modules = join(__dirname, "../node_modules");

const app = express();
app.use(express.json());

// CORS Configuration
const allowedOrigins = [
  "https://lix.opral.com",
  "https://lix.host",
  "https://flashtype.ai",
];

if (process.env.NODE_ENV !== "production") {
  allowedOrigins.push("http://localhost:3005", "http://localhost:3009");
}

interface CorsOptions {
  origin: (
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void
  ) => void;
  credentials: boolean;
}

const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
};

app.use(cors(corsOptions));

const CHUNKING_REGEXPS = {
  line: /\n+/m,
  list: /.{8}/m,
  word: /\S+\s+/m,
};

/**
 * Detects the first chunk in a buffer.
 *
 * @param buffer - The buffer to detect the first chunk in.
 * @returns The first detected chunk, or `undefined` if no chunk was detected.
 */
export type ChunkDetector = (buffer: string) => string | null | undefined;

type delayer = (buffer: string) => number;

/**
 * Smooths text streaming output.
 *
 * @param delayInMs - The delay in milliseconds between each chunk. Defaults to
 *   10ms. Can be set to `null` to skip the delay.
 * @param chunking - Controls how the text is chunked for streaming. Use "word"
 *   to stream word by word (default), "line" to stream line by line, or provide
 *   a custom RegExp pattern for custom chunking.
 * @returns A transform stream that smooths text streaming output.
 */
function smoothStream<TOOLS extends ToolSet>({
  _internal: { delay = originalDelay } = {},
  chunking = "word",
  delayInMs = 10,
}: {
  /** Internal. For test use only. May change without notice. */
  _internal?: {
    delay?: (delayInMs: number | null) => Promise<void>;
  };
  chunking?: ChunkDetector | RegExp | "line" | "word";
  delayInMs?: delayer | number | null;
} = {}): (options: {
  tools: TOOLS;
}) => TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>> {
  let detectChunk: ChunkDetector;

  if (typeof chunking === "function") {
    detectChunk = (buffer) => {
      const match = chunking(buffer);

      if (match == null) {
        return null;
      }

      if (match.length === 0) {
        throw new Error(`Chunking function must return a non-empty string.`);
      }

      if (!buffer.startsWith(match)) {
        throw new Error(
          `Chunking function must return a match that is a prefix of the buffer. Received: "${match}" expected to start with "${buffer}"`
        );
      }

      return match;
    };
  } else {
    const chunkingRegex =
      typeof chunking === "string" ? CHUNKING_REGEXPS[chunking] : chunking;

    if (chunkingRegex == null) {
      throw new InvalidArgumentError({
        argument: "chunking",
        message: `Chunking must be "word" or "line" or a RegExp. Received: ${chunking}`,
      });
    }

    detectChunk = (buffer) => {
      const match = chunkingRegex.exec(buffer);

      if (!match) {
        return null;
      }

      return buffer.slice(0, match.index) + match?.[0];
    };
  }

  return () => {
    let buffer = "";

    return new TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>>({
      async transform(chunk, controller) {
        if (chunk.type !== "text-delta") {
          if (buffer.length > 0) {
            controller.enqueue({ textDelta: buffer, type: "text-delta" });
            buffer = "";
          }

          controller.enqueue(chunk);
          return;
        }

        buffer += chunk.textDelta;

        let match;

        while ((match = detectChunk(buffer)) != null) {
          controller.enqueue({ textDelta: match, type: "text-delta" });
          buffer = buffer.slice(match.length);

          const _delayInMs =
            typeof delayInMs === "number"
              ? delayInMs
              : (delayInMs?.(buffer) ?? 10);

          await delay(_delayInMs);
        }
      },
    });
  };
}

// AI Command Streaming Endpoint
// @ts-expect-error - overload type error
app.post("/api/ai/command", async (req, res) => {
  const { apiKey: key, messages, model = "gpt-4o", system } = req.body;
  const apiKey = key || process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return res.status(401).json({ error: "Missing OpenAI API key." });
  }

  const openai = createOpenAI({ apiKey });

  let isInCodeBlock = false;
  let isInTable = false;
  let isInList = false;
  let isInLink = false;

  const controller = new AbortController();
  const { signal } = controller;

  // Abort the operation if the client disconnects
  req.on("close", () => {
    if (res.writableEnded) {
      console.log("Client disconnected, aborting stream.");
      controller.abort(); // Abort only when the client disconnects
    }
  });

  try {
    const result = streamText({
      // Attach the abort signal
      abortSignal: signal,
      experimental_transform: smoothStream({
        chunking: (buffer) => {
          // Check for code block markers
          if (/```[^\s]+/.test(buffer)) {
            isInCodeBlock = true;
          } else if (isInCodeBlock && buffer.includes("```")) {
            isInCodeBlock = false;
          }
          // test case: should not deserialize link with markdown syntax
          if (buffer.includes("http")) {
            isInLink = true;
          } else if (buffer.includes("https")) {
            isInLink = true;
          } else if (buffer.includes("\n") && isInLink) {
            isInLink = false;
          }
          if (buffer.includes("*") || buffer.includes("-")) {
            isInList = true;
          } else if (buffer.includes("\n") && isInList) {
            isInList = false;
          }
          // Simple table detection: enter on |, exit on double newline
          if (!isInTable && buffer.includes("|")) {
            isInTable = true;
          } else if (isInTable && buffer.includes("\n\n")) {
            isInTable = false;
          }

          // Use line chunking for code blocks and tables, word chunking otherwise
          // Choose the appropriate chunking strategy based on content type
          let match;

          if (isInCodeBlock || isInTable || isInLink) {
            // Use line chunking for code blocks and tables
            match = CHUNKING_REGEXPS.line.exec(buffer);
          } else if (isInList) {
            // Use list chunking for lists
            match = CHUNKING_REGEXPS.list.exec(buffer);
          } else {
            // Use word chunking for regular text
            match = CHUNKING_REGEXPS.word.exec(buffer);
          }
          if (!match) {
            return null;
          }

          return buffer.slice(0, match.index) + match?.[0];
        },
        delayInMs: () => (isInCodeBlock || isInTable ? 100 : 30),
      }),
      maxTokens: 2048,
      messages: convertToCoreMessages(messages),
      model: openai(model),
      system,
    });

    result.pipeTextStreamToResponse(res);
  } catch (error: any) {
    if (error.name === "AbortError") {
      console.log("Stream aborted by client.");
      return res.status(499).end(); // Client closed request
    }
    console.error("AI Command Error:", error);
    res.status(500).json({ error: "Failed to process AI request" });
  }
});

// AI Copilot Endpoint
// @ts-expect-error - overload type error
app.post("/api/ai/copilot", async (req, res) => {
  const { apiKey: key, model = "gpt-4o-mini", prompt, system } = req.body;
  const apiKey = key || process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return res.status(401).json({ error: "Missing OpenAI API key." });
  }

  const openai = createOpenAI({ apiKey });

  // const controller = new AbortController();
  // const { signal } = controller;

  // Abort the operation if client disconnects
  // req.on("close", () => {
  //   if (res.writableEnded === false) {
  //     controller.abort();
  //   }
  // });

  try {
    const result = await generateText({
      // abortSignal: req.signal,
      maxTokens: 50,
      model: openai(model),
      prompt,
      system,
      temperature: 0.7,
    });

    res.json(result);
  } catch (error: any) {
    if (error.name === "AbortError") {
      return res.status(408).json(null);
    }

    console.error("AI Copilot Error:", error);
    res.status(500).json({ error: "Failed to process AI request" });
  }
});

app.get(["", "/"], (req, res) => {
  res.redirect("/app/fm");
});

// Serve static files from the 'public' directory
app.use(express.static(join(__dirname, "../public")));

// Middleware to forward browser fetch requests to the correct subpath
app.use((req, res, next) => {
  // Skip for /file-manager
  if (req.url?.startsWith("/file-manager") || req.url === "/") {
    return next();
  }

  if (req.headers.referer === undefined) {
    return next();
  }

  const refererPath = new URL(req.headers.referer).pathname;
  const isAppReferer = refererPath?.startsWith("/app");
  if (!isAppReferer) {
    return next();
  }

  const refererAppName = isAppReferer ? refererPath.split("/")[2] : null;

  // Exception for cross-app navigation
  if (req.url?.startsWith("/app") && refererAppName !== req.url.split("/")[2]) {
    console.log("Cross-app navigation detected");
    return next();
  }

  if (
    refererPath?.startsWith(`/app/${refererAppName}`) &&
    !req.url.startsWith(`/app/${refererAppName}`)
  ) {
    req.url = `/app/${refererAppName}` + req.url.replace(/\/$/, "");
  }

  return next();
});

// Serve pre-built Lix apps
const lixApps = [
  {
    route: "fm",
    module: "lix-file-manager",
  },
  {
    route: "csv",
    module: "csv-app",
  },
  {
    route: "flashtype",
    module: "md-app",
  },
];

for (const lixApp of lixApps) {
  app.use(
    `/app/${lixApp.route}`,
    express.static(`${node_modules}/${lixApp.module}/dist`)
  );
  app.get(`/app/${lixApp.route}/*`, (req, res) => {
    const indexPath = join(node_modules, `${lixApp.module}/dist/index.html`);
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.status(404).send("File not found");
    }
  });
}

// LSP Handler
const lspHandler = await createServerProtocolHandler({
  environment: createLspInMemoryEnvironment(),
});

app.use("/lsp/*", async (req, res) => {
  const fetchRequest = new Request(req.url, {
    method: req.method,
    headers: req.headers as any,
    body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
  });

  const response = await lspHandler(fetchRequest);
  res.status(response.status);
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.send(await response.text());
});

// Start the server
const port = 3005;
app.listen(port, () => {
  console.info(`Server running at http://localhost:${port}/`);
});
