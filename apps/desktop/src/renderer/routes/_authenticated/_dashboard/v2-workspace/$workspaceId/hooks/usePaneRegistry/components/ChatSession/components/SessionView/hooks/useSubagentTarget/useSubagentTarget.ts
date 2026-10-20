import { useLingui } from "@lingui/react/macro";
import type { SessionClient } from "@superset/chat/client";
import type { SessionSnapshot } from "@superset/chat/core";
import { subagentItem, subagentOutcome } from "@superset/chat/core";
import type { UserContent } from "@superset/chat/protocol";
import { toast } from "@superset/ui/sonner";
import { useCallback, useMemo, useState } from "react";
import type { ComposerTarget } from "../../../Composer";

type Send = (content: UserContent[], options: { steer: boolean }) => unknown;

export function useSubagentTarget({
	client,
	items,
	focusedId,
	draftKey,
	onSend,
	onStop,
	onUnsent,
}: {
	client: Pick<SessionClient, "steerSubagent">;
	items: SessionSnapshot["items"];
	focusedId: string | null;
	draftKey: string;
	onSend: Send;
	onStop: (taskId: string) => void;
	onUnsent: (content: UserContent[]) => void;
}): {
	onSend: Send;
	target: ComposerTarget | undefined;
	draftKey: string;
} {
	const { t } = useLingui();
	const [hostCannotSteer, setHostCannotSteer] = useState(false);
	const item = subagentItem(items, focusedId);
	const itemId = item?.id;
	const name = item ? item.title || t({ message: "Subagent" }) : "";
	const outcome = item ? subagentOutcome(item) : undefined;
	const unreachableReason = t({ message: `${name} can't be messaged` });
	const hostTooOldReason = t({
		message: "Update this host to message subagents",
	});
	const canStop = item?.canStop === true;

	const disabledReason = !item
		? undefined
		: hostCannotSteer
			? hostTooOldReason
			: outcome === "stopped"
				? t({ message: `${name} stopped` })
				: item.canSteer
					? undefined
					: outcome === "failed"
						? t({ message: `${name} failed` })
						: unreachableReason;

	const stop = useCallback(() => {
		if (itemId) onStop(itemId);
	}, [itemId, onStop]);

	const target = useMemo<ComposerTarget | undefined>(
		() =>
			itemId
				? {
						name,
						...(disabledReason ? { disabledReason } : {}),
						...(canStop ? { onStop: stop } : {}),
					}
				: undefined,
		[itemId, name, disabledReason, canStop, stop],
	);

	const steer = useCallback(
		async (content: UserContent[]) => {
			if (!itemId) return;
			try {
				const result = await client.steerSubagent(itemId, content);
				if (result === "steered") return;
				onUnsent(content);
				if (result === "unsupported") {
					setHostCannotSteer(true);
					toast.error(hostTooOldReason);
				} else {
					toast.error(unreachableReason);
				}
			} catch (error) {
				console.warn("[useSubagentTarget] could not message subagent", error);
				onUnsent(content);
				toast.error(
					t({
						message: "Couldn't send your message. It's back in the composer.",
					}),
				);
			}
		},
		[client, itemId, onUnsent, hostTooOldReason, unreachableReason, t],
	);

	return {
		onSend: itemId ? steer : onSend,
		target,
		draftKey: itemId ? `${draftKey}:subagent:${itemId}` : draftKey,
	};
}
