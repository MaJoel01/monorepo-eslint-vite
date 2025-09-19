import {
	OperationNodeTransformer,
	type KyselyPlugin,
	type OnConflictNode,
	type PluginTransformQueryArgs,
	type PluginTransformResultArgs,
	type QueryResult,
	type RootOperationNode,
	type UnknownRow,
	type ValueListNode,
	type ValueNode,
	type ValuesNode,
} from "kysely";
import type { Lix } from "@lix-js/sdk";

const textDecoder = new TextDecoder();

export class JsonPlugin implements KyselyPlugin {
	#serializeJsonTransformer = new SerializeJsonTransformer();
	#engine: NonNullable<Lix["engine"]>;

	constructor(args: { engine: NonNullable<Lix["engine"]> }) {
		this.#engine = args.engine;
	}

	transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
		if (
			args.node.kind === "InsertQueryNode" ||
			args.node.kind === "UpdateQueryNode"
		) {
			return this.#serializeJsonTransformer.transformNode(args.node);
		}
		return args.node;
	}

	async transformResult(
		args: PluginTransformResultArgs
	): Promise<QueryResult<UnknownRow>> {
		for (const row of args.result.rows) {
			for (const key of Object.keys(row)) {
				const value = (row as Record<string, unknown>)[key];
				const parsed = this.#parseValue(value);
				if (parsed !== undefined && parsed !== value) {
					(row as Record<string, unknown>)[key] = parsed;
				}
			}
		}

		return args.result;
	}

	#parseValue(value: unknown): unknown {
		if (value === null || value === undefined) {
			return value;
		}

		if (value instanceof ArrayBuffer) {
			return this.#parseFromBuffer(new Uint8Array(value));
		}

		if (ArrayBuffer.isView(value)) {
			const view = value as ArrayBufferView;
			return this.#parseFromBuffer(
				new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
			);
		}

		if (typeof value === "string") {
			return parseJsonString(value);
		}

		return value;
	}

	#parseFromBuffer(buffer: Uint8Array): unknown {
		try {
			const rows = this.#engine.sqlite.exec("SELECT json(?)", {
				returnValue: "resultRows",
				bind: [buffer],
			});
			const first = rows?.[0];
			const serialized = Array.isArray(first) ? first[0] : first;
			if (typeof serialized === "string") {
				return JSON.parse(serialized);
			}
		} catch {
			// fall back to decoding as UTF-8 below
		}

		try {
			return JSON.parse(textDecoder.decode(buffer));
		} catch {
			return buffer;
		}
	}
}

class SerializeJsonTransformer extends OperationNodeTransformer {
	protected override transformOnConflict(node: OnConflictNode): OnConflictNode {
		return super.transformOnConflict({
			...node,
			updates: node.updates?.map((updateItem) => {
				if (updateItem.kind !== "ColumnUpdateNode") {
					return updateItem;
				}
				return {
					kind: "ColumnUpdateNode",
					column: updateItem.column,
					value: this.transformValue(updateItem.value as ValueNode),
				};
			}),
		});
	}

	protected override transformValue(node: ValueNode): ValueNode {
		const serialized = maybeSerializeJson(node.value);
		if (serialized === node.value) {
			return node;
		}
		return {
			...node,
			value: serialized,
		};
	}

	protected override transformValueList(node: ValueListNode): ValueListNode {
		return {
			...node,
			values: node.values.map((listNodeItem) => {
				if (listNodeItem.kind !== "ValueNode") {
					return listNodeItem;
				}
				const valueNode = listNodeItem as ValueNode;
				const serialized = maybeSerializeJson(valueNode.value);
				if (serialized === valueNode.value) {
					return valueNode;
				}
				return {
					...valueNode,
					value: serialized,
				};
			}),
		};
	}

	override transformValues(node: ValuesNode): ValuesNode {
		return super.transformValues({
			...node,
			values: node.values.map((valueItemNode) => {
				if (valueItemNode.kind !== "PrimitiveValueListNode") {
					return valueItemNode;
				}

				return {
					kind: "ValueListNode",
					values: valueItemNode.values.map(
						(value) =>
							({
								kind: "ValueNode",
								value,
							}) as ValueNode
					),
				} satisfies ValueListNode;
			}),
		});
	}
}

function maybeSerializeJson(value: unknown): unknown {
	if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
		return value;
	}
	if (value === null || value === undefined) {
		return value;
	}
	if (typeof value === "object") {
		return JSON.stringify(value);
	}
	return value;
}

function parseJsonString(value: string): unknown {
	const trimmed = value.trim();
	if (!trimmed) {
		return value;
	}

	const firstChar = trimmed[0];
	if (firstChar !== "{" && firstChar !== "[" && firstChar !== '"') {
		return value;
	}

	try {
		return JSON.parse(trimmed);
	} catch {
		return value;
	}
}
