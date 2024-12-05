import { z } from "./deps.ts";
import type { ZodType } from "./deps.ts";

export async function fetchJSONOnlyOk<T = unknown>(response: Response): Promise<T> {
    if (!response.ok) {
        throw await HTTPError.fromResponse(response);
    }
    return response.json() as Promise<T>;
}

export async function fetchNoBody<T extends undefined>(response: Response): Promise<T> {
    if (response.status !== 204) {
        throw await HTTPError.fromResponse(response);
    }

    return undefined as T;
}

export function fetchJSONZod<T extends ZodType, R extends z.output<T>>(validator: T): (response: Response) => Promise<R> {
    return (response) =>
        fetchJSONOnlyOk<unknown>(response)
            .then((body) => validator.parseAsync(body));
}

export class HTTPError extends Error {
    override readonly name = "HTTPError";
    readonly status: number;
    readonly path: string;
    readonly body: unknown | undefined;

    // deno-lint-ignore no-explicit-any
    constructor(status: number, path: string, body: unknown | undefined, ...params: any[]) {
        super(...params);
        this.status = status;
        this.path = path;
        this.body = body;
    }

    override get message(): string {
        const body = JSON.stringify(this.body);
        return `Server responded with code ${this.status}${body ? `: ${body}` : ""}`;
    }

    static async fromResponse(response: Response): Promise<HTTPError> {
        const url = new URL(response.url);
        const body = response.body !== null ? await response.json() : undefined;
        const { status } = response;

        return new HTTPError(status, url.pathname, body);
    }
}
