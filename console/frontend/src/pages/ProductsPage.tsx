// SPDX-License-Identifier: MIT
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link as RouterLink } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import IconButton from "@mui/material/IconButton";
import Link from "@mui/material/Link";
import Skeleton from "@mui/material/Skeleton";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import AddIcon from "@mui/icons-material/Add";
import ChevronIcon from "@mui/icons-material/ChevronRight";
import CheckIcon from "@mui/icons-material/Check";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import CloudIcon from "@mui/icons-material/CloudOutlined";
import RefreshIcon from "@mui/icons-material/Refresh";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { Pill } from "../components/Pill";
import { ReadinessPill } from "../components/ReadinessPill";
import { CloudPill, forInstalls, useInstall } from "../components/Clouds";
import { ApiError, checkProduct, cloudList, listProducts, listRunnables, type Product, type ProductRelease, type Runnable } from "../api";
import { useAuth } from "../auth/AuthContext";
import { cart, useCart } from "../cart";
import { actionRef } from "../compose";
import { when } from "../time";
import { imageName, imageVersion } from "../imageRef";

/** How many releases an opened product shows before "Show all". The recent ones are what a DAG author wants. */
const RELEASES_SHOWN = 4;
const WEEK_MS = 7 * 86_400_000;

/** Products no team owns are grouped under this heading, after the real platforms. */
const UNOWNED_GROUP = "Platform-provided";

type Filter = "all" | "not_ready" | "deprecated" | "shared" | "week" | "elsewhere";

function matches(product: Product, query: string): boolean {
  return (
    product.name.toLowerCase().includes(query) ||
    product.action.toLowerCase().includes(query) ||
    (product.displayName ?? "").toLowerCase().includes(query) ||
    (product.teamName ?? UNOWNED_GROUP).toLowerCase().includes(query) ||
    // Any release, not only the current image, so a search for an old tag
    // still finds the product it belongs to.
    product.image.toLowerCase().includes(query) ||
    product.releases.some((r) => r.image.toLowerCase().includes(query))
  );
}

const notReady = (p: Product) => p.readiness?.state === "not_ready" || p.readiness?.state === "failed";
const releasedThisWeek = (p: Product) => {
  const at = p.releases[0]?.registeredAt;
  return Boolean(at) && Date.now() - Date.parse(at ?? "") < WEEK_MS;
};
const sharedWith = (p: Product) => (p.shareWith.includes("*") ? "every team" : p.shareWith.length > 0 ? p.shareWith.join(", ") : "its own team only");

/** "aws-platform's team.yaml", "its product.yaml": where a product's clouds are set. */
const setIn = (p: Product) => (p.cloudsFrom === "team" ? `${p.teamName ?? "its team"}'s team.yaml` : "its product.yaml");

/** A product's state here: for other installs, deprecated, its check's answer, or that it has none. */
function ProductState({ product, install, cloud }: { product: Product; install: string; cloud: string }) {
  if (!product.runsHere) {
    const where = setIn(product);
    return <CloudPill clouds={product.clouds} title={`Set in ${where.charAt(0).toUpperCase()}${where.slice(1)}. Not checked or run on ${install}${cloud ? `, which is on ${cloud}` : ""}.`} />;
  }
  if (product.deprecated) return <Pill tone="warning" title={product.deprecated}>Deprecated</Pill>;
  if (product.readiness) return <ReadinessPill readiness={product.readiness} />;
  return <Pill tone="neutral">No check</Pill>;
}

function Tile({ label, value, note, tone }: { label: string; value: ReactNode; note: ReactNode; tone?: "success" | "error" }) {
  return (
    <Card sx={{ px: 2.25, py: 2, display: "flex", flexDirection: "column", gap: 0.5 }}>
      <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
        {label}
      </Typography>
      <Typography sx={{ fontSize: 26, fontWeight: 600, lineHeight: 1.2, fontVariantNumeric: "tabular-nums", color: tone ? `${tone}.dark` : "text.primary" }}>{value}</Typography>
      <Typography variant="caption" sx={{ fontSize: 12, overflowWrap: "anywhere" }}>
        {note}
      </Typography>
    </Card>
  );
}

/**
 * Every team's products (ProductService/ListProducts), as each catalog
 * release registers them -- kept up to date by the catalog, not something
 * anyone edits here. Deliberately NOT the source of truth for what a DAG
 * can reference: kernel/ has no concept of this table at all.
 *
 * By team, as the catalog is: a section per team, a row per product
 * (whether it's ready on this install, who it's shared with, its
 * releases), and a row opens to its check, its releases (every image it
 * has been registered with, the current one marked latest) and Run.
 */
export function ProductsPage() {
  const { install, cloud } = useInstall();
  const [products, setProducts] = useState<Product[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  // The actions the caller may run on their own (shared with them), and the templates, to say which use a product.
  const [runnables, setRunnables] = useState<Runnable[]>([]);

  useEffect(() => {
    listRunnables()
      .then(setRunnables)
      // Only Run, Add to cart and "used by" depend on it; the registry still shows.
      .catch(() => undefined);
    listProducts()
      .then(setProducts)
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Failed to load products.");
      });
  }, []);

  const runnable = useMemo(() => new Set(runnables.filter((r) => r.kind === "action" && r.shared).map((r) => r.name)), [runnables]);
  const query = search.trim().toLowerCase();
  const all = products ?? [];
  const FILTERS: [Filter, string, (p: Product) => boolean][] = [
    ["all", "All", () => true],
    ["not_ready", "Not ready", notReady],
    ["deprecated", "Deprecated", (p) => Boolean(p.deprecated)],
    ["shared", "Shared with my teams", (p) => runnable.has(p.name)],
    ["week", "Released this week", releasedThisWeek],
    // Only when there are some.
    ...(all.some((p) => !p.runsHere) ? [["elsewhere", "For other installs", (p: Product) => !p.runsHere] satisfies [Filter, string, (p: Product) => boolean]] : []),
  ];
  const test = FILTERS.find(([id]) => id === filter)?.[2] ?? (() => true);

  /** Teams in name order, unowned products last. */
  const platforms = useMemo(() => {
    if (!products) return null;
    const byPlatform = new Map<string, Product[]>();
    for (const product of products.filter((p) => (!query || matches(p, query)) && test(p))) {
      const platform = product.teamName ?? UNOWNED_GROUP;
      byPlatform.set(platform, [...(byPlatform.get(platform) ?? []), product]);
    }
    return [...byPlatform.entries()].sort(([a], [b]) => {
      if (a === UNOWNED_GROUP) return 1;
      if (b === UNOWNED_GROUP) return -1;
      return a.localeCompare(b);
    });
    // test follows filter and runnable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products, query, filter, runnable]);

  const teamCount = new Set(all.map((p) => p.teamName ?? UNOWNED_GROUP)).size;
  const ready = all.filter((p) => p.readiness?.state === "ready").length;
  const elsewhere = all.filter((p) => !p.runsHere);
  const elsewhereClouds = [...new Set(elsewhere.flatMap((p) => p.clouds))].sort();
  const problems = all.filter(notReady);
  const narrowed = query !== "" || filter !== "all";

  return (
    <Box sx={{ maxWidth: 1280, mx: "auto", display: "flex", flexDirection: "column", gap: 3 }}>
      <Box>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 0.75 }}>
          <Link component={RouterLink} to="/catalog">
            Catalog
          </Link>{" "}
          / Every product
        </Typography>
        <PageHeader
          title="Every product"
          help={{ guide: "10-ordering-and-the-cart", section: "whats-in-the-catalog", label: "What's in the catalog" }}
          subtitle="Every team's products, as each catalog release registers them, by team: whether each is ready on this install, who it's shared with, and its releases. Run one shared with you on its own, or find templates that use it in the Catalog."
          action={
            <Button component={RouterLink} to="/catalog" variant="outlined" size="large">
              Back to the catalog
            </Button>
          }
        />
      </Box>

      {error && <Alert severity="error">{error}</Alert>}

      {products && products.length > 0 && (
        <Box component="section" aria-label="Summary" sx={{ display: "grid", gap: 1.75, gridTemplateColumns: { xs: "repeat(2, minmax(0, 1fr))", md: "repeat(4, minmax(0, 1fr))" }, mt: -1 }}>
          <Tile
            label="Products"
            value={all.length}
            note={`from ${String(teamCount)} ${teamCount === 1 ? "team" : "teams"}${elsewhere.length > 0 ? `; ${String(elsewhere.length)} ${forInstalls(elsewhereClouds).replace(/^F/, "f")}` : ""}`}
          />
          <Tile
            label={`Ready on ${install}`}
            value={ready}
            note={elsewhere.length > 0 ? `of the ${String(all.length - elsewhere.length)} checked here, at least daily` : "by their own checks, at least daily"}
            tone="success"
          />
          <Tile
            label="Not ready, or check failed"
            value={problems.length}
            note={problems.length > 0 ? problems.map((p) => `${imageName(p.image)}.${p.action}`).join(", ") : "none"}
            tone={problems.length > 0 ? "error" : undefined}
          />
          <Tile label="Shared with your teams" value={all.filter((p) => runnable.has(p.name)).length} note={`of ${String(all.length)}`} />
        </Box>
      )}

      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1.5, alignItems: "center" }}>
        <TextField
          size="small"
          type="search"
          placeholder="Search teams, products or image tags"
          slotProps={{ htmlInput: { "aria-label": "Search teams, products or image tags" } }}
          value={search}
          onChange={(event) => { setSearch(event.target.value); }}
          sx={{ flex: "1 1 280px", maxWidth: 420, bgcolor: "background.paper", "& .MuiInputBase-root": { minHeight: 44 } }}
        />
        <Box role="group" aria-label="Show" sx={{ display: "flex", flexWrap: "wrap", gap: 0.75 }}>
          {FILTERS.map(([id, label, fits]) => {
            const on = filter === id;
            return (
              <Box
                key={id}
                component="button"
                type="button"
                aria-pressed={on}
                onClick={() => { setFilter(id); }}
                sx={{
                  height: 36,
                  px: 1.75,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 0.75,
                  borderRadius: 999,
                  font: "inherit",
                  fontSize: 13,
                  cursor: "pointer",
                  border: 1,
                  borderColor: on ? "primary.main" : "tint.field",
                  bgcolor: on ? "info.light" : "background.paper",
                  color: on ? "info.main" : "text.primary",
                  fontWeight: on ? 500 : 400,
                  "&:focus-visible": { outline: (t) => `2px solid ${t.palette.primary.main}`, outlineOffset: 2 },
                }}
              >
                {label}
                {products && (
                  <Box component="span" sx={{ fontSize: 12, color: "text.secondary" }}>
                    {all.filter(fits).length}
                  </Box>
                )}
              </Box>
            );
          })}
        </Box>
      </Box>

      {platforms === null && !error && (
        <Box>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} variant="rounded" height={56} sx={{ mb: 1 }} />
          ))}
        </Box>
      )}
      {platforms?.length === 0 && (
        <Card>
          <EmptyState
            message={products && products.length > 0 ? "No products match this search or filter." : "No products registered yet. A catalog release registers its teams' products."}
            help={products && products.length > 0 ? undefined : { guide: "reference-catalog-guide", label: "Publishing to the catalog" }}
          />
        </Card>
      )}
      {platforms?.map(([platform, platformProducts], i) => (
        // Remounted when a search or filter starts or ends, so matches open
        // and everything goes back to the first team open afterwards.
        <TeamSection
          key={`${platform}:${narrowed ? "narrowed" : "browse"}`}
          platform={platform}
          products={platformProducts}
          defaultOpen={narrowed || i === 0}
          runnable={runnable}
          runnables={runnables}
          install={install}
          cloud={cloud}
        />
      ))}
    </Box>
  );
}

function TeamSection({
  platform,
  products,
  defaultOpen,
  runnable,
  runnables,
  install,
  cloud,
}: {
  platform: string;
  products: Product[];
  defaultOpen: boolean;
  runnable: Set<string>;
  runnables: Runnable[];
  install: string;
  cloud: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [opened, setOpened] = useState<string | null>(null);
  const lastRelease = products.flatMap((p) => p.releases.map((r) => r.registeredAt)).sort().at(-1);
  const unready = products.filter(notReady).length;
  const deprecated = products.filter((p) => p.deprecated).length;
  const checked = products.filter((p) => p.readiness).length;
  const sharedNote = products.some((p) => runnable.has(p.name)) ? "" : " · not shared with your teams";
  // Every product of it for other installs: said once, for the team.
  const allElsewhere = products.every((p) => !p.runsHere);
  return (
    <Card component="section" aria-label={platform} sx={{ overflow: "hidden" }}>
      <Box sx={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 1.25, px: 2.5, py: 1 }}>
        <Box
          component="button"
          type="button"
          aria-expanded={open}
          onClick={() => { setOpen((o) => !o); }}
          sx={{ all: "unset", boxSizing: "border-box", cursor: "pointer", minHeight: 44, display: "flex", alignItems: "center", gap: 1.5, flexWrap: "wrap", "&:focus-visible": { outline: (t) => `2px solid ${t.palette.primary.main}`, outlineOffset: 2, borderRadius: 1 } }}
        >
          <ChevronIcon aria-hidden="true" sx={{ fontSize: 20, color: "text.secondary", transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }} />
          <Typography component="span" sx={{ fontSize: 17, fontWeight: 600 }}>
            {platform}
          </Typography>
          <Typography component="span" variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
            {products.length} {products.length === 1 ? "product" : "products"}
            {lastRelease && ` · last release ${when(lastRelease)}`}
            {platform !== UNOWNED_GROUP && sharedNote}
          </Typography>
        </Box>
        <Box sx={{ display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap" }}>
          {unready > 0 && <Pill tone="error">{unready} not ready</Pill>}
          {deprecated > 0 && <Pill tone="warning">{deprecated} deprecated</Pill>}
          {unready === 0 && deprecated === 0 && checked > 0 && checked === products.length && <Pill tone="success">All ready</Pill>}
          {allElsewhere && <CloudPill clouds={[...new Set(products.flatMap((p) => p.clouds))].sort()} />}
          {platform !== UNOWNED_GROUP && (
            <Link component={RouterLink} to={`/teams/${encodeURIComponent(platform)}`} variant="body2" sx={{ fontSize: 13 }}>
              Its team page
            </Link>
          )}
        </Box>
      </Box>
      {open && (
        <Box sx={{ overflowX: "auto", borderTop: 1, borderColor: "divider" }} tabIndex={0} aria-label={`${platform}'s products`}>
          <Table size="small" sx={{ minWidth: 900 }}>
            <TableHead>
              <TableRow>
                <TableCell>Product</TableCell>
                <TableCell>Action</TableCell>
                <TableCell>Latest</TableCell>
                <TableCell>On {install}</TableCell>
                <TableCell>Shared with</TableCell>
                <TableCell>Releases</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {products.map((product) => {
                const isOpen = opened === product.id;
                const toggle = () => { setOpened(isOpen ? null : product.id); };
                const latest = product.releases[0];
                return (
                  <Fragment key={product.id}>
                    <TableRow hover onClick={toggle} sx={{ cursor: "pointer", bgcolor: isOpen ? "background.default" : undefined, "& td": { py: 1.5 } }}>
                      <TableCell>
                        <Box sx={{ display: "flex", alignItems: "center", gap: 1.25 }}>
                          <ChevronIcon aria-hidden="true" sx={{ fontSize: 16, color: "text.secondary", transform: isOpen ? "rotate(90deg)" : "none" }} />
                          <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25, minWidth: 0 }}>
                            <Box
                              component="button"
                              type="button"
                              aria-expanded={isOpen}
                              onClick={(e) => { e.stopPropagation(); toggle(); }}
                              sx={{ all: "unset", cursor: "pointer", fontWeight: 500, color: "primary.main", fontSize: 13, "&:focus-visible": { outline: (t) => `2px solid ${t.palette.primary.main}`, outlineOffset: 2 } }}
                            >
                              {product.displayName ?? imageName(product.image)}
                            </Box>
                            <Typography sx={{ fontFamily: "fontFamilyMono", fontSize: 12, color: "text.secondary" }}>{imageName(product.image)}</Typography>
                          </Box>
                        </Box>
                      </TableCell>
                      <TableCell sx={{ fontFamily: "fontFamilyMono", fontSize: 12 }}>{product.action}</TableCell>
                      <TableCell>
                        <Box component="span" title={product.image} sx={{ fontFamily: "fontFamilyMono", fontSize: 12, px: 1, py: 0.375, borderRadius: "6px", bgcolor: "tint.neutral", whiteSpace: "nowrap" }}>
                          {imageVersion(product.image) || "—"}
                        </Box>
                      </TableCell>
                      <TableCell>
                        <ProductState product={product} install={install} cloud={cloud} />
                      </TableCell>
                      <TableCell>{sharedWith(product)}</TableCell>
                      <TableCell sx={{ color: "text.secondary", whiteSpace: "nowrap" }}>
                        {product.releases.length}
                        {latest && ` · ${when(latest.registeredAt)}`}
                      </TableCell>
                    </TableRow>
                    {isOpen && (
                      <TableRow>
                        <TableCell colSpan={6} sx={{ bgcolor: "background.default", pl: { xs: 2, sm: 5.5 }, pr: 2, pt: 0.75, pb: 2.5 }}>
                          <ProductDetail product={product} runnable={runnable.has(product.name)} runnables={runnables} install={install} cloud={cloud} />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </Box>
      )}
    </Card>
  );
}

/** What its check said here: who it acts as, what it lacks, when; and Check now for its team. */
function ReadinessDetail({ product, install }: { product: Product; install: string }) {
  const { user } = useAuth();
  const [asked, setAsked] = useState<string | null>(null);
  const r = product.readiness;
  if (!r) return null;
  const mine = Boolean(user?.isAdmin || (product.teamName && user?.teamNames.includes(product.teamName)));
  const bad = r.state === "not_ready";
  return (
    <Box sx={{ bgcolor: "background.paper", border: 1, borderColor: bad ? "tint.errorBorder" : r.state === "failed" ? "tint.warningBorder" : "divider", borderRadius: 2, px: 2, py: 1.75, display: "flex", flexDirection: "column", gap: 1 }}>
      <Typography sx={{ fontWeight: 600, fontSize: 13, color: bad ? "error.dark" : r.state === "ready" ? "success.dark" : "text.primary" }}>
        {r.state === "ready" && `Ready on ${install}`}
        {r.state === "not_ready" && `Not ready on ${install}`}
        {r.state === "failed" && "Its check couldn't say"}
        {r.state === "checking" && "Being checked"}
        {r.state === "unchecked" && "Not checked yet"}
        {r.principal && (
          <>
            , acting as{" "}
            <Box component="span" sx={{ fontFamily: "fontFamilyMono", fontSize: 12 }}>
              {r.principal}
            </Box>
          </>
        )}
      </Typography>
      {r.state === "checking" && (r.missing.length > 0 || r.detail || r.principal) && (
        <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
          Shown here is its last check&apos;s answer, until this one finishes.
        </Typography>
      )}
      {r.missing.length > 0 && (
        <Box component="ul" sx={{ m: 0, pl: 2.25 }}>
          {r.missing.map((m) => (
            <Typography component="li" variant="body2" key={m} sx={{ fontSize: 13 }}>
              {m}
            </Typography>
          ))}
        </Box>
      )}
      {r.detail && (
        <Typography variant="body2" sx={{ fontSize: 13 }}>
          {r.detail}
        </Typography>
      )}
      <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
        {r.checkedAt ? `Checked ${when(r.checkedAt)}, by its check action. ` : ""}
        It&apos;s checked again when its image changes, a day after its last answer, or on Check now.
      </Typography>
      <Box sx={{ display: "flex", gap: 1.25, alignItems: "center", flexWrap: "wrap" }}>
        {mine && r.state !== "checking" && (
          <Button
            variant="outlined"
            size="small"
            startIcon={<RefreshIcon />}
            sx={{ minHeight: 36, bgcolor: "background.paper" }}
            onClick={() => {
              checkProduct(product.name)
                .then((started) => { setAsked(started ? "Checking now: refresh in a minute." : "A check is already under way."); })
                .catch((err: unknown) => { setAsked(err instanceof ApiError ? err.message : "Couldn't start it."); });
            }}
          >
            Check now
          </Button>
        )}
        {r.executionId && (
          <Link component={RouterLink} to={`/runs/${r.executionId}`} variant="body2" sx={{ fontSize: 13 }}>
            The check run
          </Link>
        )}
        {asked && (
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
            {asked}
          </Typography>
        )}
      </Box>
    </Box>
  );
}

/**
 * In place of its readiness, for a product for other installs: which
 * installs it's for, that it isn't checked or run here, and the catalog
 * file that says so (linked when the catalog gives its address).
 */
function CloudsDetail({ product, cloud, sourceUrl }: { product: Product; cloud: string; sourceUrl: string | null }) {
  const mono = (text: string) => (
    <Box component="span" sx={{ fontFamily: "fontFamilyMono", fontSize: 12 }}>
      {text}
    </Box>
  );
  const clouds = mono(`clouds: [${product.clouds.join(", ")}]`);
  return (
    <Box sx={{ bgcolor: "background.paper", border: 1, borderColor: "divider", borderRadius: 2, px: 2, py: 1.75, display: "flex", flexDirection: "column", gap: 0.75 }}>
      <Typography sx={{ fontWeight: 600, fontSize: 13, display: "flex", alignItems: "center", gap: 0.75 }}>
        <CloudIcon aria-hidden="true" sx={{ fontSize: 16, color: "text.secondary" }} />
        {forInstalls(product.clouds)}
      </Typography>
      <Typography variant="body2" sx={{ fontSize: 13 }}>
        This install is {cloud ? `on ${cloud}` : "on another cloud"}, so it isn&apos;t checked or run here.
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
        {product.cloudsFrom === "team" ? (
          <>
            Set in {product.teamName ?? "its team"}&apos;s {mono("team.yaml")} ({clouds}), for all its products; its {mono("product.yaml")} doesn&apos;t change it.
          </>
        ) : (
          <>
            Set in its {mono("product.yaml")} ({clouds}).
            {sourceUrl && (
              <>
                {" "}
                <Link href={sourceUrl} target="_blank" rel="noopener noreferrer">
                  product.yaml in the catalog ↗
                </Link>
              </>
            )}
          </>
        )}
      </Typography>
    </Box>
  );
}

function ProductDetail({ product, runnable, runnables, install, cloud }: { product: Product; runnable: boolean; runnables: Runnable[]; install: string; cloud: string }) {
  const [all, setAll] = useState(false);
  const inCart = useCart().actions.includes(product.name);
  const notHereId = `not-here-${product.id}`;
  const ref = actionRef(product, "");
  const templates = runnables.filter((r) => r.kind === "template" && r.actions.includes(ref));
  const shown = all ? product.releases : product.releases.slice(0, RELEASES_SHOWN);
  const mono = (text: string) => (
    <Box component="span" sx={{ fontFamily: "fontFamilyMono", fontSize: 12 }}>
      {text}
    </Box>
  );
  return (
    <Box sx={{ display: "grid", gap: 2.5, gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "minmax(0, 1.2fr) minmax(0, 1fr)" }, fontSize: 13 }}>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5, minWidth: 0 }}>
        <Typography variant="body2" sx={{ fontSize: 13, overflowWrap: "anywhere" }}>
          Registered as {mono(product.name)} · shared with {sharedWith(product)}
          {product.secretRefs.length > 0 && <> · uses {mono(product.secretRefs.join(", "))}</>}
          {product.serviceAccount && <> · runs as {mono(product.serviceAccount)}</>}
          {product.tokenAudiences.length > 0 && <> · tokens for {product.tokenAudiences.join(", ")}</>}
        </Typography>
        {product.description && (
          <Typography variant="body2" sx={{ fontSize: 13 }}>
            {product.description}
          </Typography>
        )}
        {product.deprecated && <Alert severity="warning">Deprecated: {product.deprecated}</Alert>}
        <ReadinessDetail product={product} install={install} />
        {!product.runsHere && <CloudsDetail product={product} cloud={cloud} sourceUrl={runnables.find((r) => r.kind === "action" && r.name === product.name)?.sourceUrl ?? null} />}
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1.25, alignItems: "center" }}>
          {runnable && !product.runsHere && (
            <>
              <Button size="small" variant="contained" disabled aria-describedby={notHereId} sx={{ minHeight: 36 }}>
                Run on its own
              </Button>
              <Button size="small" variant="outlined" startIcon={<AddIcon />} disabled aria-describedby={notHereId} sx={{ minHeight: 36 }}>
                Add to cart
              </Button>
              <Typography id={notHereId} variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
                Runs only on {cloudList(product.clouds)} installs.
              </Typography>
            </>
          )}
          {runnable && product.runsHere && (
            <>
              <Button component={RouterLink} to={`/catalog/run?action=${encodeURIComponent(product.name)}`} size="small" variant="contained" sx={{ minHeight: 36 }}>
                Run on its own
              </Button>
              {inCart ? (
                <Button component={RouterLink} to="/catalog/cart" size="small" variant="outlined" color="success" startIcon={<CheckIcon />} sx={{ minHeight: 36 }}>
                  In your cart
                </Button>
              ) : (
                <Button size="small" variant="outlined" startIcon={<AddIcon />} onClick={() => { cart.add(product.name); }} sx={{ minHeight: 36, bgcolor: "background.paper" }}>
                  Add to cart
                </Button>
              )}
            </>
          )}
          {templates.length > 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
              Used by the {templates.length === 1 ? "template" : "templates"}{" "}
              {templates.map((t, i) => (
                <Fragment key={`${t.team}/${t.name}`}>
                  {i > 0 && ", "}
                  <Link component={RouterLink} to={`/catalog/run?template=${encodeURIComponent(`${t.team}/${t.name}`)}`}>
                    {t.displayName || t.name}
                  </Link>
                </Fragment>
              ))}
            </Typography>
          )}
        </Box>
      </Box>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
        <Typography sx={{ fontWeight: 600, fontSize: 13 }}>Releases</Typography>
        {shown.map((release) => (
          <ReleaseRow key={release.image} release={release} isLatest={release.image === product.image} />
        ))}
        {product.releases.length > RELEASES_SHOWN && (
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
            <Typography variant="caption" color="text.secondary" sx={{ fontSize: 12 }}>
              {all ? `All ${String(product.releases.length)} releases.` : `Showing the ${String(RELEASES_SHOWN)} most recent of ${String(product.releases.length)} releases.`}
            </Typography>
            <Button size="small" onClick={() => { setAll((a) => !a); }}>
              {all ? "Show fewer" : "Show all"}
            </Button>
          </Box>
        )}
      </Box>
    </Box>
  );
}

function ReleaseRow({ release, isLatest }: { release: ProductRelease; isLatest: boolean }) {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(release.image);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 1500);
    } catch {
      // Clipboard access can be refused (an insecure origin, a denied
      // permission). The full reference is on screen to select by hand.
    }
  }

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1.25, pl: 1.25, pr: 0.5, py: 0.75, bgcolor: "background.paper", border: 1, borderColor: "tint.rule", borderRadius: 2 }}>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25, minWidth: 0, flex: "1 1 auto" }}>
        <Box component="span" sx={{ fontFamily: "fontFamilyMono", fontSize: 12, wordBreak: "break-all" }}>
          {release.image}
        </Box>
        <Typography variant="caption" color="text.secondary" sx={{ fontSize: 12 }}>
          Registered {new Date(release.registeredAt).toLocaleString()}
        </Typography>
      </Box>
      {isLatest && <Pill tone="success">Latest</Pill>}
      <Tooltip title={copied ? "Copied" : "Copy image reference"}>
        <IconButton aria-label="Copy image reference" onClick={() => void copy()} sx={{ flexShrink: 0, width: 36, height: 36 }}>
          {copied ? <CheckIcon fontSize="small" color="success" /> : <ContentCopyIcon fontSize="small" />}
        </IconButton>
      </Tooltip>
    </Box>
  );
}
