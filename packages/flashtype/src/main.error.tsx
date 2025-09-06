import { useState } from "react";
import { OpfsStorage } from "@lix-js/sdk";

/**
 * Minimal error UI shown when Lix fails to load.
 *
 * Provides a destructive action to reset the Origin Private File System (OPFS)
 * using `OpfsStorage.clean()` and then reloads the app. This action deletes
 * ALL OPFS data for this origin and cannot be undone.
 *
 * If this error is unexpected, please contact the developer.
 *
 * @example
 * <ErrorFallback error={new Error("failed to open Lix")} />
 */
export function ErrorFallback(props: { error: unknown }) {
	const [busy, setBusy] = useState(false);

	async function handleReset() {
		if (busy) return;
		const confirmed = window.confirm(
			"This will delete ALL data stored by this site in your browser (OPFS).\n\n" +
				"This cannot be undone and will likely result in data loss.\n\n" +
				"Do you want to proceed?",
		);
		if (!confirmed) return;
		try {
			setBusy(true);
			await OpfsStorage.clean();
			window.location.reload();
		} catch (e) {
			console.error("Failed to reset OPFS:", e);
			setBusy(false);
			alert("Failed to reset OPFS. See console for details.");
		}
	}

	return (
		<div className="min-h-dvh w-full flex items-center justify-center p-6">
			<div className="max-w-xl w-full border rounded-lg p-6 bg-card text-card-foreground">
				<h1 className="text-xl font-semibold mb-2">
					Flashtype failed to start
				</h1>
				<p className="text-sm text-muted-foreground mb-4">
					Lix could not be loaded. This can happen if the lix schema was changed in development. If this is unexpected, please contact the
					developer.
				</p>
				<div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 mb-4">
					<p className="text-sm font-medium text-destructive">
						Warning: resetting storage will delete data and cannot be undone.
					</p>
				</div>
				<div className="flex items-center gap-3">
					<button
						onClick={handleReset}
						disabled={busy}
						className="inline-flex items-center gap-2 rounded-md bg-red-600 px-3 py-2 text-white text-sm disabled:opacity-60"
					>
						{busy ? "Resetting…" : "Reset OPFS (data loss)"}
					</button>
					<button
						onClick={() => window.location.reload()}
						className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
					>
						Reload app
					</button>
				</div>
				{import.meta.env.DEV ? (
					<pre className="mt-4 whitespace-pre-wrap text-xs opacity-70">
						{String(
							props.error instanceof Error
								? props.error.stack || props.error.message
								: props.error,
						)}
					</pre>
				) : null}
			</div>
		</div>
	);
}
