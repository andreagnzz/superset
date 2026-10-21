import { describe, expect, test } from "bun:test";
import { Sandbox } from "@vercel/sandbox";
import { stub } from "../../../test/stub";
import {
	findSandboxSession,
	listActiveWorkspaceSandboxes,
	SESSION_TIMEOUT_MS,
	topUpRunningSession,
} from "./vercel";

type ListOptions = NonNullable<Parameters<typeof Sandbox.list>[0]>;

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const sandboxes = [
	{
		name: "environment",
		status: "running",
		createdAt: NOW,
		updatedAt: NOW,
		statusUpdatedAt: NOW,
		tags: { kind: "environment" },
	},
	{
		name: "untagged",
		status: "running",
		createdAt: NOW - HOUR,
		updatedAt: NOW - HOUR,
		statusUpdatedAt: NOW - HOUR,
	},
	{
		name: "recently-stopped",
		status: "stopped",
		createdAt: NOW - DAY,
		updatedAt: NOW - DAY,
		statusUpdatedAt: NOW - 2 * HOUR,
		tags: { kind: "workspace" },
	},
	{
		name: "dormant",
		status: "stopped",
		createdAt: NOW - 3 * DAY,
		updatedAt: NOW - 3 * DAY,
		statusUpdatedAt: NOW - 2 * DAY,
		tags: { kind: "workspace" },
	},
	{
		name: "resumed-workspace",
		status: "running",
		createdAt: NOW - 7 * DAY,
		updatedAt: NOW - 7 * DAY,
		statusUpdatedAt: NOW - 3 * HOUR,
		tags: { kind: "workspace" },
	},
];
let listOptions: ListOptions | undefined;

stub(Sandbox, {
	list: async (options: ListOptions) => {
		listOptions = options;
		const ordered = options.tags
			? sandboxes
					.filter((sandbox) => sandbox.tags?.kind === "workspace")
					.toSorted((a, b) => b.createdAt - a.createdAt)
			: sandboxes.toSorted((a, b) => b.statusUpdatedAt - a.statusUpdatedAt);
		return (async function* () {
			yield* ordered;
		})();
	},
});

describe("findSandboxSession", () => {
	stub(Sandbox, {
		get: async () => ({
			listSessions: async () =>
				(async function* () {
					for (let index = 0; index <= 20; index += 1) {
						yield {
							id: `session_${index}`,
							memory: 16_384,
							vcpus: 8,
							status: "stopped",
							startedAt: NOW - HOUR,
							stoppedAt: NOW,
							updatedAt: NOW,
						};
					}
				})(),
		}),
	});

	test("settlement finds a recorded session beyond the first page", async () => {
		expect(await findSandboxSession("workspace", "session_20")).toEqual({
			session: {
				id: "session_20",
				memoryMb: 16_384,
				vcpus: 8,
				startedAt: NOW - HOUR,
				endedAt: NOW,
				activeCpuMs: null,
			},
		});
	});
});

describe("listActiveWorkspaceSandboxes", () => {
	test("finds older resumed workspaces when tag-filtered lists use creation order", async () => {
		expect(await listActiveWorkspaceSandboxes(NOW - 4 * HOUR)).toEqual([
			"recently-stopped",
			"resumed-workspace",
		]);
		expect(listOptions).toMatchObject({
			sortBy: "statusUpdatedAt",
			sortOrder: "desc",
		});
		expect(listOptions).not.toHaveProperty("tags");
	});
});

describe("topUpRunningSession", () => {
	const session = (remainingMs: number, startedAt = NOW - HOUR) => {
		const extended: number[] = [];
		const sandbox = {
			expiresAt: new Date(NOW + remainingMs) as Date | undefined,
			currentSession: () => ({
				startedAt: new Date(startedAt),
				createdAt: new Date(startedAt),
				extendTimeout: (ms: number) => {
					extended.push(ms);
					sandbox.expiresAt = new Date(
						(sandbox.expiresAt?.getTime() ?? 0) + ms,
					);
					return Promise.resolve();
				},
			}),
		};
		return { sandbox, extended };
	};

	test("extends a session to a full timeout from now", async () => {
		const { sandbox, extended } = session(SESSION_TIMEOUT_MS / 2);
		const endsAt = await topUpRunningSession(sandbox, NOW);
		expect(extended).toEqual([SESSION_TIMEOUT_MS / 2]);
		expect(endsAt?.getTime()).toBe(NOW + SESSION_TIMEOUT_MS);
	});

	test("stops at the plan's 24h per-session cap", async () => {
		const { sandbox, extended } = session(HOUR / 2, NOW - DAY + HOUR);
		const endsAt = await topUpRunningSession(sandbox, NOW);
		expect(extended).toEqual([HOUR / 2]);
		expect(endsAt?.getTime()).toBe(NOW + HOUR);
	});

	test("skips a session that is already nearly full", async () => {
		const { sandbox, extended } = session(SESSION_TIMEOUT_MS - 30_000);
		await topUpRunningSession(sandbox, NOW);
		expect(extended).toEqual([]);
	});
});
