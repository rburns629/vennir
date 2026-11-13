// SPDX-License-Identifier: MIT
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { cachedImageCount, checkImage, CYCLONEDX_PREDICATE, fetchSbom, listTags, parseImageRef, pinImages } from "../src/registry.js";

// A fake registry behind a stubbed fetch: GAR-style token auth, where an
// anonymous HEAD gets a Bearer challenge, the token service takes Basic
// credentials, and the manifest answers 200 or 404.
const HOST = "us-central1-docker.pkg.dev";
const CREDENTIAL = { username: "_json_key", password: "secret" };
const ALLOWED = [`${HOST}/proj/catalog-products/`];
const DIGEST = `sha256:${"a".repeat(64)}`;
const EXPECTED_BASIC = `Basic ${Buffer.from("_json_key:secret").toString("base64")}`;

interface Call {
  url: string;
  authorization: string | undefined;
}
let calls: Call[];
let existing: Set<string>;
let realm: string;

function fakeRegistry(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const authorization = (init?.headers as Record<string, string> | undefined)?.["authorization"];
  calls.push({ url: url.href, authorization });
  if (url.pathname === "/v2/token") {
    return Promise.resolve(
      authorization === EXPECTED_BASIC
        ? Response.json({ token: "registry-token" })
        : new Response(null, { status: 401 }),
    );
  }
  if (authorization !== "Bearer registry-token") {
    return Promise.resolve(
      new Response(null, {
        status: 401,
        headers: { "www-authenticate": `Bearer realm="${realm}",service="${HOST}"` },
      }),
    );
  }
  return Promise.resolve(
    existing.has(url.pathname)
      ? new Response(null, { status: 200, headers: { "docker-content-digest": DIGEST } })
      : new Response(null, { status: 404 }),
  );
}

/** A fresh image name, so the one-minute cache never answers for another test. */
function image(): { ref: string; manifestPath: string } {
  const name = `product-${randomUUID().slice(0, 8)}`;
  return { ref: `${HOST}/proj/catalog-products/${name}:abc`, manifestPath: `/v2/proj/catalog-products/${name}/manifests/abc` };
}

beforeEach(() => {
  calls = [];
  existing = new Set();
  realm = `https://${HOST}/v2/token`;
  config.registryCredentials.set(HOST, CREDENTIAL);
  vi.stubGlobal("fetch", vi.fn(fakeRegistry));
});

afterEach(() => {
  config.registryCredentials.clear();
  vi.unstubAllGlobals();
});

describe("parseImageRef", () => {
  it("splits registry, repository and tag or digest", () => {
    expect(parseImageRef(`${HOST}/p/r/img:1.2`)).toEqual({ host: HOST, repository: "p/r/img", reference: "1.2" });
    expect(parseImageRef("localhost:5000/img@sha256:abc")).toEqual({
      host: "localhost:5000", repository: "img", reference: "sha256:abc",
    });
    // How a submission is pinned: the tag stays for people, the digest is asked for.
    expect(parseImageRef(`${HOST}/p/img:latest@sha256:abc`)).toEqual({
      host: HOST, repository: "p/img", reference: "sha256:abc",
    });
    expect(parseImageRef("docker.io/nginx")).toEqual({
      host: "registry-1.docker.io", repository: "library/nginx", reference: "latest",
    });
  });

  it("has nothing to ask for an image with no registry host", () => {
    expect(parseImageRef("demo-1-greet-product:local")).toBeNull();
    expect(parseImageRef("team/product:1")).toBeNull();
  });

  it("reads nothing with a part a URL would resolve away", () => {
    expect(parseImageRef(`${HOST}/p/../../other/img:1`)).toBeNull();
    expect(parseImageRef(`${HOST}/p/./img:1`)).toBeNull();
    expect(parseImageRef(`${HOST}/p//img:1`)).toBeNull();
  });
});

describe("checkImage", () => {
  it("reports an existing image as available and a deleted one as missing", async () => {
    const present = image();
    existing.add(present.manifestPath);
    expect(await checkImage(present.ref, ALLOWED)).toBe("available");
    expect(await checkImage(image().ref, ALLOWED)).toBe("missing");
  });

  it("sends the credential only to the registry's token service, never with the manifest request", async () => {
    await checkImage(image().ref, ALLOWED);
    const token = calls.filter((c) => c.url.startsWith(realm));
    expect(token).toHaveLength(1);
    expect(token[0]?.authorization).toBe(EXPECTED_BASIC);
    expect(calls.filter((c) => c.authorization === EXPECTED_BASIC)).toHaveLength(1);
  });

  it("remembers a bounded number of images", async () => {
    for (let i = 0; i < 1100; i++) await checkImage(image().ref, ALLOWED);
    expect(cachedImageCount()).toBeLessThanOrEqual(1000);
  });

  it("never contacts a registry outside the allowed sources", async () => {
    expect(await checkImage(`registry.example.com/x/${randomUUID()}:1`, ALLOWED)).toBe("unverified");
    expect(await checkImage("169.254.169.254/latest/meta-data:1", ALLOWED)).toBe("unverified");
    expect(await checkImage(`${HOST}/other-project/repo/app:1`, ALLOWED)).toBe("unverified");
    expect(await checkImage("demo-1-greet-product:local", ALLOWED)).toBe("unverified");
    expect(calls).toEqual([]);
  });

  it("asks an allowed public registry anonymously", async () => {
    config.registryCredentials.clear();
    await checkImage(image().ref, ALLOWED);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.authorization === undefined || c.authorization.startsWith("Bearer"))).toBe(true);
  });

  it("won't hand the credential to a token service on another host", async () => {
    realm = "https://attacker.example.com/token";
    expect(await checkImage(image().ref, ALLOWED)).toBe("unverified");
    expect(calls.some((c) => c.url.startsWith(realm))).toBe(false);
  });

  it("treats an unreachable registry as unverified, not missing", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))));
    expect(await checkImage(image().ref, ALLOWED)).toBe("unverified");
  });

  it("asks the registry once for checks of one image at the same time", async () => {
    const tagged = image();
    existing.add(tagged.manifestPath);
    const statuses = await Promise.all(Array.from({ length: 8 }, () => checkImage(tagged.ref, ALLOWED)));
    expect(statuses).toEqual(Array(8).fill("available"));
    expect(calls.filter((call) => call.url.endsWith(tagged.manifestPath))).toHaveLength(2); // the 401, then signed in
  });

  it("remembers an unanswered check for seconds, not the minute an answer is kept", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const tagged = image();
      existing.add(tagged.manifestPath);
      vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("timeout"))));
      expect((await pinImages([tagged.ref], ALLOWED)).unresolved).toEqual([tagged.ref]);
      vi.stubGlobal("fetch", vi.fn(fakeRegistry));
      expect((await pinImages([tagged.ref], ALLOWED)).unresolved).toEqual([tagged.ref]); // still remembered
      vi.setSystemTime(Date.now() + 4_000);
      expect((await pinImages([tagged.ref], ALLOWED)).unresolved).toEqual([tagged.ref]);
      vi.setSystemTime(Date.now() + 2_000);
      expect((await pinImages([tagged.ref], ALLOWED)).pinned.get(tagged.ref)).toBe(`${tagged.ref}@${DIGEST}`);
      vi.setSystemTime(Date.now() + 50_000);
      vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("timeout"))));
      expect((await pinImages([tagged.ref], ALLOWED)).pinned.get(tagged.ref)).toBe(`${tagged.ref}@${DIGEST}`); // the answer, kept
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("pinImages", () => {
  it("pins a tag to the digest it names now, keeps a pinned image, and lists what it couldn't resolve", async () => {
    const tagged = image();
    existing.add(tagged.manifestPath);
    const missing = image();
    const pinnedAlready = `${HOST}/proj/catalog-products/x@sha256:${"b".repeat(64)}`;
    const outside = "registry.elsewhere.example/app:1";
    const { pinned, unresolved } = await pinImages([tagged.ref, missing.ref, pinnedAlready, outside], ALLOWED);
    expect(pinned.get(tagged.ref)).toBe(`${tagged.ref}@${DIGEST}`);
    expect(pinned.get(pinnedAlready)).toBe(pinnedAlready);
    expect(unresolved.sort()).toEqual([missing.ref, outside].sort());
  });

  it("asks a registry through its mirror, with the image host's credential", async () => {
    config.registryMirrors.set(HOST, "http://kind-registry:5000");
    try {
      const tagged = image();
      existing.add(tagged.manifestPath);
      const { pinned } = await pinImages([tagged.ref], ALLOWED);
      expect(pinned.get(tagged.ref)).toBe(`${tagged.ref}@${DIGEST}`);
      expect(calls.some((call) => call.url.startsWith("http://kind-registry:5000/v2/proj/"))).toBe(true);
      expect(calls.some((call) => call.url.startsWith(`https://${HOST}/v2/proj/`))).toBe(false);
    } finally {
      config.registryMirrors.clear();
    }
  });
});

describe("listTags", () => {
  it("reads every page of a repository's tags, signed in as for manifests", async () => {
    const pages: Record<string, string[]> = { "": ["c1", "latest"], latest: ["v1.0.0", "v1.1.0"], "v1.1.0": [] };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        if (url.pathname !== "/v2/proj/catalog-products/catalog-release/tags/list") return fakeRegistry(input, init);
        const authorization = (init?.headers as Record<string, string> | undefined)?.["authorization"];
        if (authorization !== "Bearer registry-token") return fakeRegistry(input, init);
        const last = url.searchParams.get("last") ?? "";
        const tags = pages[last] ?? [];
        const more = tags.length > 0 && last !== "latest";
        return Promise.resolve(Response.json({ tags }, { headers: more ? { link: "</v2/...>; rel=\"next\"" } : {} }));
      }),
    );
    expect(await listTags(`${HOST}/proj/catalog-products/catalog-release:latest`)).toEqual(["c1", "latest", "v1.0.0", "v1.1.0"]);
  });
});

describe("fetchSbom", () => {
  const digestOf = (data: string) => `sha256:${createHash("sha256").update(data).digest("hex")}`;
  const image = `${HOST}/proj/catalog-products/site@${DIGEST}`;
  const attPath = `/v2/proj/catalog-products/site/manifests/${DIGEST.replace(":", "-")}.att`;

  function serve(files: Record<string, { body: string; status?: number }>) {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        const authorization = (init?.headers as Record<string, string> | undefined)?.["authorization"];
        const file = files[decodeURIComponent(url.pathname)];
        if (!file || authorization !== "Bearer registry-token") return fakeRegistry(input, init);
        return Promise.resolve(new Response(file.body, { status: file.status ?? 200 }));
      }),
    );
  }

  it("reads the CycloneDX predicate catalog CI attested, checked against its digest", async () => {
    const bom = { bomFormat: "CycloneDX", components: [{ name: "openssl", version: "3.0.22" }] };
    const statement = { _type: "https://in-toto.io/Statement/v0.1", predicateType: CYCLONEDX_PREDICATE, predicate: bom };
    const envelope = JSON.stringify({ payloadType: "application/vnd.in-toto+json", payload: Buffer.from(JSON.stringify(statement)).toString("base64"), signatures: [{ sig: "x" }] });
    const layerDigest = digestOf(envelope);
    const manifest = JSON.stringify({ layers: [{ mediaType: "application/vnd.dsse.envelope.v1+json", digest: layerDigest, annotations: { predicateType: CYCLONEDX_PREDICATE } }] });
    serve({ [attPath]: { body: manifest }, [`/v2/proj/catalog-products/site/blobs/${layerDigest}`]: { body: envelope } });
    expect(JSON.parse((await fetchSbom(image)) ?? "null")).toEqual(bom);
  });

  it("is null when nothing is attested, and refuses a blob that isn't its digest", async () => {
    serve({});
    existing.clear();
    expect(await fetchSbom(image)).toBeNull();
    const manifest = JSON.stringify({ layers: [{ digest: digestOf("other"), annotations: { predicateType: CYCLONEDX_PREDICATE } }] });
    serve({ [attPath]: { body: manifest }, [`/v2/proj/catalog-products/site/blobs/${digestOf("other")}`]: { body: "tampered" } });
    await expect(fetchSbom(image)).rejects.toThrow(/doesn't match/);
  });
});
