// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { catalogFileUrl } from "./catalogFile";

describe("a catalog file's GitHub page", () => {
  it("creates it filled in, or edits it, from owner/name or the repository's address", () => {
    expect(catalogFileUrl("acme/catalog", "teams/web/secret-stores/secretstore.yaml", "new", "kind: SecretStore\n")).toBe(
      "https://github.com/acme/catalog/new/main?filename=teams%2Fweb%2Fsecret-stores%2Fsecretstore.yaml&value=kind%3A+SecretStore%0A",
    );
    expect(catalogFileUrl("https://github.com/acme/catalog", "teams/web/secret-stores/secretstore.yaml", "edit")).toBe(
      "https://github.com/acme/catalog/edit/main/teams/web/secret-stores/secretstore.yaml",
    );
  });
});
