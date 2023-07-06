import { z } from "./deps.ts";
import type { ZodType } from "./deps.ts";

import { fetchJSONZod, fetchNoBody } from "./http.ts";

function buildVaultRequest(
    vaultAddr: string | URL,
    vaultNamespace: string | undefined,
    vaultToken: string | undefined,
    endpoint: string,
    opts?: RequestInit,
    body?: unknown,
): Promise<Response> {
    const url = new URL(`/v1/${endpoint}`, vaultAddr);
    const headers: Headers = new Headers(opts?.headers);

    if (vaultNamespace) {
        headers.append("X-Vault-Namespace", `${vaultNamespace}/`);
    }

    if (vaultToken) {
        headers.append("X-Vault-Token", vaultToken);
    }

    if (body && (opts?.method ?? "GET") !== "GET") {
        headers.append("Content-type", "application/json");
    }

    return fetch(url, {
        ...opts,
        headers,
        body: (!opts?.body && body && (opts?.method ?? "GET") !== "GET") ? JSON.stringify(body) : opts?.body,
    });
}

export async function doVaultFetch<T extends ZodType | undefined, R extends (T extends ZodType ? z.output<T> : undefined)>(
    validator: T,
    vaultAddr: string | URL,
    vaultNamespace: string | undefined,
    vaultToken: string | undefined,
    endpoint: string,
    opts?: RequestInit,
    body?: unknown,
): Promise<R> {
    const response = await buildVaultRequest(
        vaultAddr,
        vaultNamespace,
        vaultToken,
        endpoint,
        opts,
        body,
    );

    if (validator === undefined) {
        return await fetchNoBody<R>(response);
    }

    return await fetchJSONZod(validator)(response);
}
