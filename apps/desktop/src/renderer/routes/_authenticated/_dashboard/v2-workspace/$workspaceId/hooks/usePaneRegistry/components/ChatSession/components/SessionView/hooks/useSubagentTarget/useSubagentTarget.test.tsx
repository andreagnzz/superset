import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { SteerSubagentResult } from "@superset/chat/client";
import type { SessionSnapshot } from "@superset/chat/core";
import type { ToolCall, UserContent } from "@superset/chat/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useComposerDraft } from "../../../Composer/hooks/useComposerDraft";
import { useSubagentTarget } from "./useSubagentTarget";

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

const explore: ToolCall = {
	id: "subagent:c1",
	kind: "tool_call",
	title: "Explore",
	toolKind: "think",
	toolName: "subagent",
	status: "running",
	content: [],
	startedAtMs: 1,
	subagent: true,
	subagentStatus: "running",
	canSteer: true,
	canStop: true,
	canBackground: false,
};

const typed: UserContent[] = [{ type: "text", text: "Skip the tests" }];

function itemsOf(item: ToolCall): SessionSnapshot["items"] {
	return new Map([[item.id, { item, turnId: "t1" }]]);
}

function renderTarget(item: ToolCall, result: SteerSubagentResult = "steered") {
	const steerSubagent = mock(
		async (_taskId: string, _content: UserContent[]) => result,
	);
	const sendPrompt = mock((_content: UserContent[]) => {});
	const stopTask = mock((_taskId: string) => {});
	const onUnsent = mock((_content: UserContent[]) => {});
	const hook = renderHook(() =>
		useSubagentTarget({
			client: { steerSubagent },
			draftKey: "chat-v3-draft:t1",
			focusedId: item.id,
			items: itemsOf(item),
			onSend: sendPrompt,
			onStop: stopTask,
			onUnsent,
		}),
	);
	return { hook, steerSubagent, sendPrompt, stopTask, onUnsent };
}

test("typing while focused messages the subagent", async () => {
	const { hook, steerSubagent, sendPrompt } = renderTarget(explore);
	expect(hook.result.current.target?.name).toBe("Explore");
	expect(hook.result.current.target?.disabledReason).toBeUndefined();
	await act(async () => {
		await hook.result.current.onSend(typed, { steer: false });
	});
	expect(steerSubagent).toHaveBeenCalledWith("subagent:c1", typed);
	expect(sendPrompt).not.toHaveBeenCalled();
});

test("an idle subagent's composer is enabled", () => {
	const { hook } = renderTarget({
		...explore,
		status: "completed",
		subagentStatus: "idle",
		canStop: false,
	});
	expect(hook.result.current.target?.disabledReason).toBeUndefined();
	expect(hook.result.current.target?.onStop).toBeUndefined();
});

test("a stopped or failed subagent disables the composer with the reason", () => {
	const stopped = renderTarget({
		...explore,
		status: "canceled",
		subagentStatus: "stopped",
		canSteer: false,
		canStop: false,
	});
	expect(stopped.hook.result.current.target?.disabledReason).toBe(
		"Explore stopped",
	);
	const failed = renderTarget({
		...explore,
		status: "failed",
		subagentStatus: "failed",
		canSteer: false,
		canStop: false,
	});
	expect(failed.hook.result.current.target?.disabledReason).toBe(
		"Explore failed",
	);
	const resumable = renderTarget({
		...explore,
		status: "failed",
		subagentStatus: "failed",
		canSteer: true,
		canStop: false,
	});
	expect(resumable.hook.result.current.target?.disabledReason).toBeUndefined();
});

test("a subagent without controls can't be messaged", () => {
	const {
		subagentStatus: _status,
		canSteer: _steer,
		canStop: _stop,
		canBackground: _background,
		...claudeTask
	} = explore;
	const { hook } = renderTarget(claudeTask);
	expect(hook.result.current.target?.disabledReason).toBe(
		"Explore can't be messaged",
	);
	expect(hook.result.current.target?.onStop).toBeUndefined();
});

test("stop reads the item and stops its task", () => {
	const { hook, stopTask } = renderTarget(explore);
	act(() => hook.result.current.target?.onStop?.());
	expect(stopTask).toHaveBeenCalledWith("subagent:c1");
});

test("a host too old to message subagents gives the text back and says so", async () => {
	const { hook, onUnsent } = renderTarget(explore, "unsupported");
	await act(async () => {
		await hook.result.current.onSend(typed, { steer: false });
	});
	expect(onUnsent).toHaveBeenCalledWith(typed);
	expect(hook.result.current.target?.disabledReason).toBe(
		"Update this host to message subagents",
	);
});

test("drafts are kept per target", () => {
	const hook = renderHook(
		({ focusedId }: { focusedId: string | null }) => {
			const target = useSubagentTarget({
				client: { steerSubagent: async () => "steered" },
				draftKey: "chat-v3-draft:t1",
				focusedId,
				items: itemsOf(explore),
				onSend: () => {},
				onStop: () => {},
				onUnsent: () => {},
			});
			return useComposerDraft(target.draftKey, target.target === undefined);
		},
		{ initialProps: { focusedId: null as string | null } },
	);
	act(() => hook.result.current.onChange("for the main agent"));

	hook.rerender({ focusedId: "subagent:c1" });
	expect(hook.result.current.storedDraft).toBeUndefined();
	act(() => hook.result.current.onChange("for Explore"));

	hook.rerender({ focusedId: null });
	expect(hook.result.current.storedDraft).toBe("for the main agent");

	hook.rerender({ focusedId: "subagent:c1" });
	expect(hook.result.current.storedDraft).toBe("for Explore");
	expect(
		Object.keys(window.localStorage).filter((key) => key.includes("subagent")),
	).toEqual([]);
});
