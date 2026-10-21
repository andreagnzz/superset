import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "@superset/db/client";
import { stub } from "../../../test/stub";
import { sandboxHostSecretFor } from "./access";
import { keepSandboxAlive } from "./keepalive";

const WORKSPACE_ID = "11111111-2222-4333-8444-555555555555";
const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

let row: { providerSandboxId: string; status: string } | undefined;
let toppedUp: string[];

stub(db.query.cloudWorkspaces, { findFirst: () => Promise.resolve(row) });

const topUp = (id: string) => {
	toppedUp.push(id);
	return Promise.resolve(new Date(NOW + HOUR));
};

async function ping(secret?: string) {
	return keepSandboxAlive(
		{
			workspaceId: WORKSPACE_ID,
			presentedSecret: secret ?? (await sandboxHostSecretFor(WORKSPACE_ID)),
		},
		topUp,
	);
}

beforeEach(() => {
	row = { providerSandboxId: "sbx", status: "ready" };
	toppedUp = [];
});

describe("keepSandboxAlive", () => {
	test("tops up a ready workspace's session", async () => {
		expect(await ping()).toBe("extended");
		expect(toppedUp).toEqual(["sbx"]);
	});

	test("refuses a wrong secret and leaves a workspace that is not ready alone", async () => {
		expect(await ping("nope")).toBe("unauthorized");
		row = { providerSandboxId: "sbx", status: "deleted" };
		expect(await ping()).toBe("not-ready");
		expect(toppedUp).toEqual([]);
	});
});
