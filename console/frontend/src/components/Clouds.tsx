// SPDX-License-Identifier: MIT
import { Link as RouterLink } from "react-router-dom";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Typography from "@mui/material/Typography";
import CloudIcon from "@mui/icons-material/CloudOutlined";
import { ApiError, cloudList } from "../api";
import { useEnvironment } from "../environment";
import { useAsk } from "../layout/ask";
import { HelpLink } from "./HelpLink";
import { Pill } from "./Pill";

/**
 * Products for some clouds only (product.yaml's or team.yaml's clouds): on
 * an install on another cloud they're listed, marked, never checked and
 * never run. A run naming one is refused (NOT_FOR_THIS_INSTALL).
 */

/** "For aws installs", "For aws and azure installs". */
export const forInstalls = (clouds: readonly string[]) => `For ${cloudList(clouds)} installs`;

/** The install's name and cloud, for saying why something can't run here. */
export function useInstall(): { install: string; cloud: string } {
  const environment = useEnvironment();
  return { install: environment?.label || "this install", cloud: environment?.cloud ?? "" };
}

/** "Can't run here: it's for aws installs, and gke-prod is on gcp." */
export function notHereReason(clouds: readonly string[], install: string, cloud: string): string {
  return `Can't run here: it's for ${cloudList(clouds)} installs${cloud ? `, and ${install} is on ${cloud}` : ""}.`;
}

/** The mark on something for other installs: a cloud, then which installs it's for. */
export function CloudPill({ clouds, title }: { clouds: readonly string[]; title?: string }) {
  return (
    <Pill tone="neutral" title={title}>
      <CloudIcon aria-hidden="true" sx={{ fontSize: 14, mx: -0.25 }} />
      {forInstalls(clouds)}
    </Pill>
  );
}

/** Which catalog file says so, as the start of a sentence: "aws-platform's team.yaml", "Its product.yaml", or its team. */
export function cloudsSource(team: string | null, cloudsFrom: string | undefined): string {
  if (cloudsFrom === "team" && team) return `${team}'s team.yaml`;
  if (cloudsFrom === "product") return "Its product.yaml";
  return team ?? "Its catalog";
}

/** Its troubleshooting section: the anchor of "Not run: it's for aws installs" (NOT_FOR_THIS_INSTALL), as rehype-slug makes it. */
const GUIDE = { guide: "15-troubleshooting", section: "not-run-its-for-aws-installs-not_for_this_install", label: "Products for some clouds only" };

/** Whether an error is a run refused because a product in it is for other installs. */
export const isNotForThisInstall = (err: unknown): err is ApiError => err instanceof ApiError && err.code === "NOT_FOR_THIS_INSTALL";

/** The product a NOT_FOR_THIS_INSTALL refusal names (its Failure detail), by its registered name. */
export function refusedProduct(err: ApiError): string | null {
  const product = err.detail?.["product"];
  return typeof product === "string" ? product : null;
}

/** What the page knows about the refused product: its name to show, its team, its clouds, and which file set them. */
export interface RefusedProduct {
  name: string;
  team: string | null;
  clouds: string[];
  cloudsFrom?: string;
}

/**
 * A run refused because a product in it is for installs on another cloud
 * (NOT_FOR_THIS_INSTALL): where refusals show (the run form, the cart,
 * Compose), what it means, what to do, and that nothing was made. `what`
 * is what was refused: a template (its team), an action on its own, or an
 * order of several.
 */
export function NotForThisInstall({ error, product, what }: { error: ApiError; product: RefusedProduct | null; what: { template: string } | "action" | "order" }) {
  const { install, cloud } = useInstall();
  const ask = useAsk();
  const clouds = product && product.clouds.length > 0 ? cloudList(product.clouds) : null;
  const name = product?.name ?? refusedProduct(error) ?? "A step";
  const asked = typeof what === "object" ? what.template : product?.team ?? null;
  const means = clouds
    ? `${cloudsSource(product?.team ?? null, product?.cloudsFrom)} says ${name} is for ${clouds} installs${cloud ? `, and ${install} is on ${cloud}` : ""}.`
    : `${name} is for installs on another cloud${cloud ? `, and ${install} is on ${cloud}` : ""}.`;
  const on = clouds ? `${/^[aeiou]/.test(clouds) ? "an" : "a"} ${clouds} install` : "an install on its cloud";
  const toDo =
    typeof what === "object"
      ? `Run it on ${on}, or ask ${what.template} to leave ${name} out of this template${cloud ? ` on ${cloud} installs` : ""}.`
      : what === "order"
        ? `Remove ${name} to run the rest here, or run it on ${on}.`
        : `Run it on ${on}. If it should run here too, ask ${product?.team ?? "its team"} to add ${cloud || "this install's cloud"} to its clouds.`;
  const again = `Nothing was made. It's refused the same way until ${typeof what === "object" ? "the template changes" : what === "order" ? "it's removed" : "its catalog files change"}.`;
  return (
    <Card component="section" role="alert" aria-labelledby="not-here-heading" sx={{ p: 3, borderColor: "error.light", display: "flex", flexDirection: "column", gap: 1.75 }}>
      <Box sx={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", gap: 1.25 }}>
        <Typography id="not-here-heading" variant="h6" component="h2" sx={{ fontSize: 18, overflowWrap: "anywhere", minWidth: 0 }}>
          Not run: {name} is for {clouds ?? "other"} installs
        </Typography>
        <Box component="span" sx={{ fontFamily: "fontFamilyMono", fontSize: 12, color: "error.dark", bgcolor: "error.light", px: 1, py: 0.5, borderRadius: 1.5 }}>
          NOT_FOR_THIS_INSTALL · nothing ran
        </Box>
      </Box>
      <Typography sx={{ fontFamily: "fontFamilyMono", fontSize: 13, overflowWrap: "anywhere" }}>{error.message}</Typography>
      <Box component="dl" sx={{ m: 0, display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", sm: "160px minmax(0, 1fr)" }, gap: { xs: "2px 0", sm: "8px 16px" }, fontSize: 14 }}>
        {[
          ["What it means", `${means} The run was refused before any step started.`],
          ["What to do", toDo],
          ["Safe to try again?", again],
        ].map(([label, text]) => (
          <Box key={label} sx={{ display: "contents" }}>
            <Box component="dt" sx={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.6px", textTransform: "uppercase", color: "text.secondary", pt: { sm: 0.25 }, mt: { xs: 1, sm: 0 } }}>
              {label}
            </Box>
            <Box component="dd" sx={{ m: 0, lineHeight: 1.55, overflowWrap: "anywhere" }}>
              {text}
            </Box>
          </Box>
        ))}
      </Box>
      <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px 16px", pt: 1.75, borderTop: 1, borderColor: "divider" }}>
        {asked && (
          <Button variant="outlined" component={RouterLink} to={`/teams/${encodeURIComponent(asked)}`}>
            Ask {asked}
          </Button>
        )}
        {typeof ask.model === "string" && (
          <Button variant="text" onClick={() => { ask.open("Why was my run refused with NOT_FOR_THIS_INSTALL, and what should I do?"); }}>
            Ask Vennir about it
          </Button>
        )}
        <Box sx={{ ml: { sm: "auto" } }}>
          <HelpLink {...GUIDE} />
        </Box>
      </Box>
    </Card>
  );
}
