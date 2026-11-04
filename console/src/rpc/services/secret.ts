// SPDX-License-Identifier: MIT
/** SecretService (proto/vennir/console/v1/secret.proto): core/secrets.ts over Connect. */
import type { ServiceImpl } from "@connectrpc/connect";
import type { JsonObject } from "@bufbuild/protobuf";
import { Type } from "@sinclair/typebox";
import {
  putSecret,
  revokeSecret,
  SecretData,
  SecretName,
  secretSources,
  SecretStoreName,
  SecretTeam,
  syncSecret,
  SyncedKeys,
  teamSecrets,
  teamSecretStores,
} from "../../core/secrets.js";
import { SecretSource, type SecretService } from "../../gen/vennir/console/v1/secret_pb.js";
import { timestamp } from "../convert.js";
import { callerOf, logOf } from "../context.js";
import { check } from "../validate.js";

/** A plain object as a Struct: dates become ISO strings, undefined drops out. */
const asStruct = (value: object): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;

export function secretService(): ServiceImpl<typeof SecretService> {
  return {
    async listSecrets(req, ctx) {
      const { team } = check({ team: SecretTeam }, req);
      const secrets = await teamSecrets(callerOf(ctx), team);
      return {
        secrets: secrets.map((secret) => ({
          id: secret.id,
          secretName: secret.secretName,
          keys: secret.keys,
          source: secret.source === "literal" ? SecretSource.LITERAL : SecretSource.EXTERNAL,
          managed: secret.managed,
          updatedAt: timestamp(secret.updatedAt),
          external: secret.external ? asStruct(secret.external) : undefined,
        })),
      };
    },

    async listSecretStores(req, ctx) {
      const { team } = check({ team: SecretTeam }, req);
      const stores = await teamSecretStores(callerOf(ctx), team);
      return {
        stores: stores.map((store) => ({
          name: store.name,
          provider: store.provider,
          providerLabel: store.providerLabel,
          location: store.location ?? undefined,
          identity: store.identity ?? undefined,
          usesStoredCredential: store.usesStoredCredential,
          ready: store.ready ?? undefined,
          message: store.message ?? undefined,
          sharedWithCount: store.sharedWithCount,
          sharedWith: store.sharedWith ?? [],
        })),
      };
    },

    async putSecret(req, ctx) {
      const input = check({ team: SecretTeam, secretName: SecretName, data: SecretData }, req);
      await putSecret(callerOf(ctx), input);
      return {};
    },

    async syncSecret(req, ctx) {
      const input = check(
        { team: SecretTeam, secretName: SecretName, secretStoreName: SecretStoreName, keys: SyncedKeys },
        {
          ...req,
          // An unset optional field is absent, as in a REST body.
          keys: req.keys.map((key) => ({
            secretKey: key.secretKey,
            remoteKey: key.remoteKey,
            ...(key.property === undefined ? {} : { property: key.property }),
          })),
        },
      );
      await syncSecret(callerOf(ctx), input);
      return {};
    },

    async revokeSecret(req, ctx) {
      const { team, secretName } = check({ team: SecretTeam, secretName: Type.String() }, req);
      await revokeSecret(callerOf(ctx), team, secretName, logOf(ctx));
      return {};
    },

    async getSecretSources() {
      return secretSources();
    },
  };
}
