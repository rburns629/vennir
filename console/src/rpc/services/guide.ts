// SPDX-License-Identifier: MIT
/**
 * GuideService (proto/vennir/console/v1/guide.proto): the guides in
 * console/docs/ and the platform's docs in console/docs/reference/, and
 * searching them (guideSearch.ts), for anyone signed in (the same content
 * for everyone).
 */
import type { ServiceImpl } from "@connectrpc/connect";
import type { GuideService } from "../../gen/vennir/console/v1/guide_pb.js";
import { Type } from "@sinclair/typebox";
import { guideIndex } from "../../guideSearch.js";
import { GuideId, GuideImagePath, listGuides, readGuide, readGuideImage } from "../../guides.js";
import { notFound } from "../errors.js";
import { check } from "../validate.js";

export function guideService(): ServiceImpl<typeof GuideService> {
  return {
    async listGuides() {
      return { guides: await listGuides() };
    },

    async getGuide(req) {
      const { id } = check({ id: GuideId }, req);
      const markdown = await readGuide(id);
      if (markdown === undefined) throw notFound("No such guide.");
      return { markdown };
    },

    async getGuideImage(req) {
      const { path } = check({ path: GuideImagePath }, req);
      const svg = await readGuideImage(path);
      if (svg === undefined) throw notFound("No such figure.");
      return { svg };
    },

    async searchGuides(req) {
      const { query } = check({ query: Type.String({ minLength: 1, maxLength: 500 }) }, { query: req.query });
      const limit = Math.min(Math.max(req.limit || 5, 1), 20);
      return { hits: (await guideIndex()).search(query, limit, req.includeHistory) };
    },
  };
}
