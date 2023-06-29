import { assertRejects, stub } from "./deps_test.ts";

function fakeFetch(): typeof globalThis.fetch {
    return (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
        return Promise.reject("No internet");
    };
}

Deno.test({
    name: "Test fetch stub",
    async fn() {
        const fetchStub = stub(globalThis, "fetch", fakeFetch());

        try {
            await assertRejects(async () => {
                await fetch("https://example.com");
            }, "No internet");
        } finally {
            fetchStub.restore();
        }
    },
});
