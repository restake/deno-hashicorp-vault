import { VAULT_AUTH_TYPE, VaultTokenCredentials } from "./auth.ts";
import { VaultClient } from "./client.ts";
import { doVaultFetch } from "./vault.ts";

import { z } from "zod";

const vaultAddress = "http://127.0.0.1:8200";
const vaultToken = "foobarbaz123";

// Spawn Vault dev server
const vaultAbort = new AbortController();
// deno-lint-ignore no-unused-vars
let vaultProcess: Deno.ChildProcess | null = null;
let spawningAllowed = true;

await (async () => {
    const permission = await Deno.permissions.request({
        name: "run",
        command: "vault",
    });

    if (permission.state !== "granted") {
        console.warn("Not allowed to spawn Vault dev server, skipping integration tests");
        spawningAllowed = false;
        return;
    }

    const cmd = new Deno.Command("vault", {
        args: ["server", "-dev", "-dev-no-store-token", `-dev-root-token-id=${vaultToken}`],
        signal: vaultAbort.signal,
        stdout: "inherit",
        stderr: "inherit",
    });

    const process = vaultProcess = cmd.spawn();
    process.output().then((result) => {
        console.log("Vault process exited", result);
    });
})();

addEventListener("unload", () => {
    vaultAbort.abort("test suite end");
});

async function healthcheck(): Promise<boolean> {
    await doVaultFetch(
        z.any(),
        vaultAddress,
        undefined,
        undefined,
        "sys/health",
        { method: "GET" },
    );

    return true;
}

async function ensureVaultReady() {
    // Ensure Vault is ready
    let i = 0;
    do {
        try {
            const ready = await healthcheck();
            if (ready) {
                return;
            }
        } catch (_e) {
            console.log("Vault is not ready yet, sleeping");
            await new Promise<void>((resolve) => setTimeout(() => resolve(), 1000));
            i++;
        }
    } while (i <= 5);

    throw new Error(`Vault is not ready after polling ${i} times`);
}

async function createVaultClient(): Promise<VaultClient<VaultTokenCredentials>> {
    const authentication: VaultTokenCredentials = {
        [VAULT_AUTH_TYPE]: "token",
        mountpoint: "auth/token",
        token: vaultToken,
    };

    const client = new VaultClient({
        address: vaultAddress,
        namespace: undefined,
        authentication,
    });

    await client.login();
    return client;
}

Deno.test({
    name: "Issue new orphan token",
    ignore: !spawningAllowed,
    async fn() {
        await ensureVaultReady();

        const client = await createVaultClient();
        const orphanToken = await client.issueToken();

        console.log("Issued new orphan token", orphanToken);
    },
});
