// SPDX-License-Identifier: MIT
import { Children, createContext, isValidElement, useContext, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link as RouterLink, useLocation, useNavigate, useParams } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Breadcrumbs from "@mui/material/Breadcrumbs";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import CircularProgress from "@mui/material/CircularProgress";
import Collapse from "@mui/material/Collapse";
import InputAdornment from "@mui/material/InputAdornment";
import Link from "@mui/material/Link";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import TextField from "@mui/material/TextField";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useTheme } from "@mui/material/styles";
import ApiIcon from "@mui/icons-material/CodeOutlined";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import BotIcon from "@mui/icons-material/SmartToyOutlined";
import BuildIcon from "@mui/icons-material/Inventory2Outlined";
import ChatIcon from "@mui/icons-material/ChatBubbleOutlineOutlined";
import CheckBoxIcon from "@mui/icons-material/CheckBox";
import CheckBoxBlankIcon from "@mui/icons-material/CheckBoxOutlineBlank";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import FixIcon from "@mui/icons-material/BuildOutlined";
import GroupsIcon from "@mui/icons-material/GroupsOutlined";
import HelpIcon from "@mui/icons-material/HelpOutlineOutlined";
import KeyIcon from "@mui/icons-material/KeyOutlined";
import ObserveIcon from "@mui/icons-material/InsightsOutlined";
import OperateIcon from "@mui/icons-material/DnsOutlined";
import PlayIcon from "@mui/icons-material/PlayArrowOutlined";
import SearchIcon from "@mui/icons-material/Search";
import Typography from "@mui/material/Typography";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import { ApiError, getDoc, listDocs, searchDocs, type DocHit, type DocSummary } from "../api";
import { helpHref } from "../components/HelpLink";
import { PageHeader } from "../components/PageHeader";
import { useAsk } from "../layout/ask";
import { API_REFERENCE_ID, ApiReference } from "./ApiReference";
import { DocFigure, FigureLink, figurePath } from "./docs/Figure";
import {
  contentsOf,
  docTarget,
  IN_DEPTH,
  isSplit,
  pageOf,
  pagesOf,
  placeOf,
  plain,
  POPULAR,
  sectionHolding,
  sectionsOf,
  slug,
  START_HERE,
  SYMPTOMS,
  TASKS,
  trailOf,
  type Answered,
  type Category,
  type Group,
  type Node,
  type Page,
} from "./docs/contents";

/** mermaid is most of this page's weight, so it's fetched only when a
 * guide actually has a diagram, and once. */
let mermaidLoader: Promise<typeof import("mermaid").default> | null = null;
function loadMermaid() {
  mermaidLoader ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({ startOnLoad: false, theme: "neutral" });
    return mermaid;
  });
  return mermaidLoader;
}

/**
 * react-markdown renders a fenced ```mermaid block as plain <pre><code> --
 * it has no idea what "mermaid" means. This intercepts exactly that one
 * language tag and renders the diagram for real; every other language
 * still falls through to the default <pre><code> (for e.g. syntax-tagged
 * ```json/```bash blocks elsewhere in these docs, which should stay as
 * plain code, not be swept into this same special case).
 */
function CodeBlock({ className, children }: { className?: string; children?: React.ReactNode }) {
  const isMermaid = className === "language-mermaid";
  const diagramId = useId().replace(/:/g, "-");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const source = String(children ?? "");

  useEffect(() => {
    if (!isMermaid || !containerRef.current) return;
    let cancelled = false;
    loadMermaid()
      .then((mermaid) => mermaid.render(`mermaid-${diagramId}`, source))
      .then(({ svg }) => {
        if (!cancelled && containerRef.current) containerRef.current.innerHTML = svg;
      })
      .catch((err: unknown) => {
        if (!cancelled && containerRef.current) {
          containerRef.current.textContent = `Failed to render diagram: ${String(err)}`;
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isMermaid, diagramId, source]);

  if (!isMermaid) return <code className={className}>{children}</code>;
  return <div ref={containerRef} />;
}

/**
 * A mermaid diagram must not end up inside a <pre> -- that's the code-block
 * background/padding/monospace styling this page applies via its own "&
 * pre" sx rule, which looks wrong around a rendered SVG. Every other
 * fenced block (```json, ```bash, ...) still needs the normal <pre> the
 * CSS actually targets.
 */
function Pre({ children }: { children?: React.ReactNode }) {
  const child = Children.only(children);
  const isMermaid = isValidElement(child) && (child.props as { className?: string }).className === "language-mermaid";
  // tabIndex: a long line scrolls the block sideways, and keyboard users
  // can only scroll what they can focus.
  return isMermaid ? <>{children}</> : <pre tabIndex={0}>{children}</pre>;
}

/** Wide tables scroll inside their own focusable box rather than widening the page. */
function DocTable({ children }: { children?: React.ReactNode }) {
  return (
    <Box tabIndex={0} role="region" aria-label="Table" sx={{ overflowX: "auto", mt: 0.5, mb: 2.25, border: 1, borderColor: "divider", borderRadius: 2, bgcolor: "background.paper", "& tr:first-of-type td": { borderTop: 0 } }}>
      <table>{children}</table>
    </Box>
  );
}

/**
 * GFM task lists ("- [x] done") render as disabled checkboxes: unlabeled
 * form controls that can't be used, and 13px targets. In a guide they're
 * a status mark, so render them as one.
 */
function TaskMark({ type, checked }: { type?: string; checked?: boolean }) {
  if (type !== "checkbox") return <input type={type} />;
  const Icon = checked ? CheckBoxIcon : CheckBoxBlankIcon;
  return (
    <Icon
      role="img"
      aria-label={checked ? "Done:" : "To do:"}
      aria-hidden={false}
      sx={{ fontSize: "1.1em", verticalAlign: "-0.2em", mr: 0.5, color: checked ? "primary.main" : "text.secondary" }}
    />
  );
}

/** The docs the console serves, and the one open: what links between docs and to a section resolve against. */
const Served = createContext<{ ids: ReadonlySet<string>; doc: string }>({ ids: new Set(), doc: "" });

/**
 * A link from one doc to another is written as the repository has it
 * ("security-model.md", "../setup.md", "clouds/gcp.md#…"). It goes to the
 * same doc here (docTarget), through react-router: a full navigation to
 * /docs/<id> would reach the backend's own GET /docs/:id (raw markdown),
 * not the app. A doc the console doesn't serve (TODO.md, the kernel's)
 * stays as its words, not a link to nowhere. A "#section" link to a part
 * of a long doc that's on another of its pages goes there (DocsPage finds
 * which); one on this page, and external links, are plain <a>s.
 */
function DocLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  const navigate = useNavigate();
  const { ids, doc } = useContext(Served);
  if (href?.startsWith("#")) {
    return (
      <a
        href={href}
        onClick={(event) => {
          if (document.getElementById(decodeURIComponent(href.slice(1)))) return;
          event.preventDefault();
          void navigate(`/docs/${doc}${href}`);
        }}
      >
        {children}
      </a>
    );
  }
  const figure = figurePath(href);
  if (figure) return <FigureLink path={figure}>{children}</FigureLink>;
  if (!href || !/^[^:]*\.md(#|$)/.test(href)) return <a href={href}>{children}</a>;
  const to = docTarget(href, ids);
  if (!to) return <>{children}</>;
  return (
    <a
      href={to}
      onClick={(event) => {
        event.preventDefault();
        void navigate(to);
      }}
    >
      {children}
    </a>
  );
}

/** An image in a doc: a figure the docs draw, fetched through the API; anything else as written. */
function DocImage({ src, alt }: { src?: string | Blob; alt?: string }) {
  const path = typeof src === "string" ? figurePath(src) : null;
  if (path) return <DocFigure path={path} alt={alt ?? ""} />;
  return <img src={typeof src === "string" ? src : undefined} alt={alt ?? ""} />;
}

interface Hast {
  type: string;
  tagName?: string;
  value?: string;
  children?: Hast[];
}
const textOf = (n: Hast): string => n.value ?? n.children?.map(textOf).join("") ?? "";

/** A troubleshooting entry's parts ("**What you see:** …"), each a labelled row; what to do stands out. */
const FIELDS = new Set(["What you see", "Why", "What to do"]);

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const todo = label === "What to do";
  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: { xs: "minmax(0, 1fr)", sm: "120px minmax(0, 1fr)" },
        gap: { xs: 0.5, sm: 1.5 },
        mb: 1.75,
        ...(todo && { bgcolor: "success.light", borderLeft: 3, borderColor: "success.main", px: 1.75, py: 1.5, borderRadius: "0 8px 8px 0" }),
      }}
    >
      <Box component="span" sx={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: todo ? "success.dark" : "text.secondary", pt: 0.5 }}>
        {label}
      </Box>
      <Box component="p" sx={{ m: "0 !important" }}>
        {children}
      </Box>
    </Box>
  );
}

/**
 * A paragraph, except one that's only an image: that's a figure, which a
 * <p> can't hold; and one that's a troubleshooting entry's part, a Field.
 */
function Paragraph({ node, children }: { node?: { children: Hast[] }; children?: React.ReactNode }) {
  const parts = node?.children.filter((c) => c.type !== "text" || c.value?.trim()) ?? [];
  if (parts.length === 1 && parts[0]?.tagName === "img") return <>{children}</>;
  const lead = node?.children[0];
  const label = lead?.tagName === "strong" ? textOf(lead).replace(/:\s*$/, "") : null;
  if (label && FIELDS.has(label)) {
    const rest = Children.toArray(children).slice(1);
    // "**Why:** the console checks…" reads, on its own row, as "The console checks…".
    if (typeof rest[0] === "string") rest[0] = rest[0].trimStart().replace(/^\p{Ll}/u, (c) => c.toUpperCase());
    return <Field label={label}>{rest}</Field>;
  }
  return <p>{children}</p>;
}

const MARKDOWN_COMPONENTS: Components = {
  img: DocImage,
  p: Paragraph,
  code: CodeBlock,
  pre: Pre,
  a: DocLink,
  table: DocTable,
  input: TaskMark,
};

const linkTo = (p: Page) => `/docs/${p.doc}${p.section ? `/${p.section}` : ""}`;

/** The guides' search (GuideService/SearchGuides): the sections that match, once there's something to look for. */
function useGuideSearch(query: string): DocHit[] | null {
  const [hits, setHits] = useState<DocHit[] | null>(null);
  const search = useDeferredValue(query.trim());
  useEffect(() => {
    if (search.length < 2) {
      setHits(null);
      return;
    }
    let current = true;
    searchDocs(search)
      .then((found) => { if (current) setHits(found); })
      .catch(() => { if (current) setHits([]); });
    return () => {
      current = false;
    };
  }, [search]);
  return hits;
}

/** The search box: the hero's, large on the dark band, or the contents' above the list. */
function SearchField({ value, onChange, large = false }: { value: string; onChange: (v: string) => void; large?: boolean }) {
  return (
    <TextField
      type="search"
      fullWidth
      size={large ? "medium" : "small"}
      placeholder={large ? "Search every guide: how do I back up the database?" : "Search the guides"}
      value={value}
      onChange={(e) => { onChange(e.target.value); }}
      slotProps={{
        htmlInput: { "aria-label": "Search the guides" },
        input: {
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon fontSize="small" sx={{ color: "text.secondary" }} />
            </InputAdornment>
          ),
        },
      }}
      sx={{
        bgcolor: "background.paper",
        borderRadius: 2,
        "& .MuiInputBase-root": large ? { height: 48, fontSize: 15 } : { height: 40, fontSize: 13 },
        ...(large && { "& fieldset": { border: 0 } }),
      }}
    />
  );
}

/** Words too common to mark. */
const COMMON = new Set(["the", "and", "not", "for", "how", "can", "does", "what", "why", "who", "with", "from", "into", "when", "where", "which", "this", "that", "its", "get"]);

/** A search's words in an excerpt, marked: each word by its stem, so "mounted" marks "mounts". */
function Marked({ text, query }: { text: string; query: string }) {
  const stems = query
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => !COMMON.has(w))
    .map((w) => w.replace(/(ing|ed|es|s)$/, ""))
    .filter((w) => w.length >= 3)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (stems.length === 0) return <>{text}</>;
  const words = new RegExp(`(\\b(?:${stems.join("|")})\\w*)`, "gi");
  return <>{text.split(words).map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : part))}</>;
}

/** A hit's excerpt as it reads: its words, not its markdown, in about two lines. */
function excerptOf(hit: DocHit): string {
  const text = plain(hit.excerpt.replace(/^#+ .*$/gm, "").replace(/^\s*[-*+]\s+/gm, "")).replace(/\s+/g, " ").trim();
  return text.length > 220 ? `${text.slice(0, 220).trimEnd()}…` : text;
}

/** What a search found: each section, in its guide, with where the words are; and Ask, when it isn't there. */
function SearchResults({ query, hits, onPick, floating = false }: { query: string; hits: DocHit[]; onPick: () => void; floating?: boolean }) {
  const ask = useAsk();
  const q = query.trim();
  return (
    <Card
      component="section"
      aria-label="Search results"
      sx={{
        overflow: "hidden",
        boxShadow: "0 8px 24px rgba(22,25,31,.08)",
        ...(floating && { position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 3, width: "min(560px, calc(100vw - 32px))", maxHeight: "70vh", overflowY: "auto" }),
      }}
    >
      <Typography sx={{ px: 2.25, py: 1.5, fontSize: 13, color: "text.secondary" }}>
        {hits.length === 0 ? "Nothing matches " : `${String(hits.length)} ${hits.length === 1 ? "section matches" : "sections match"} `}
        <Box component="b" sx={{ color: "text.primary", fontWeight: 500 }}>
          {q}
        </Box>
      </Typography>
      {hits.map((h) => {
        const heading = h.heading.split(" > ").at(-1) ?? h.heading;
        return (
          <Box
            key={`${h.guide}#${h.heading}`}
            component={RouterLink}
            to={`/docs/${h.guide}${h.heading === h.title ? "" : `#${slug(heading)}`}`}
            onClick={onPick}
            sx={{
              display: "flex",
              flexDirection: "column",
              gap: 0.5,
              px: 2.25,
              py: 1.75,
              borderTop: 1,
              borderColor: "divider",
              textDecoration: "none",
              color: "text.primary",
              "&:hover": { bgcolor: "action.hover" },
              "& mark": { bgcolor: "warning.light", color: "inherit", borderRadius: 0.5, px: 0.25 },
            }}
          >
            <Box component="span" sx={{ display: "flex", flexWrap: "wrap", gap: 1, alignItems: "baseline" }}>
              <Box component="span" sx={{ fontSize: 14, fontWeight: 500, color: "primary.main" }}>
                {heading}
              </Box>
              <Box component="span" sx={{ fontSize: 12, color: "text.secondary" }}>
                in {h.title}
                {h.kind === "history" ? " · design history, not how it works now" : ""}
              </Box>
            </Box>
            <Box component="span" sx={{ fontSize: 13, color: "text.secondary", lineHeight: 1.5 }}>
              <Marked text={excerptOf(h)} query={q} />
            </Box>
          </Box>
        );
      })}
      {typeof ask.model === "string" && (
        <Box sx={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 1.25, px: 2.25, py: 1.5, borderTop: 1, borderColor: "divider", bgcolor: "background.default", fontSize: 13 }}>
          <Box component="span" sx={{ color: "text.secondary" }}>
            Not it? Ask in your own words; the answer cites these guides.
          </Box>
          {/* What was searched for, in the box, to put in your own words. */}
          <Button variant="outlined" startIcon={<ChatIcon />} onClick={() => { ask.open(q); }}>
            Ask Vertra
          </Button>
        </Box>
      )}
    </Card>
  );
}

/** The contents' search: results float over the page, and close when one is picked. */
function NavSearch() {
  const [query, setQuery] = useState("");
  const hits = useGuideSearch(query);
  return (
    <Box sx={{ position: "relative" }}>
      <SearchField value={query} onChange={setQuery} />
      {hits && <SearchResults query={query} hits={hits} onPick={() => { setQuery(""); }} floating />}
    </Box>
  );
}

const ICONS: Record<string, React.ReactNode> = {
  run: <PlayIcon />,
  fix: <FixIcon />,
  team: <GroupsIcon />,
  automate: <BotIcon />,
  secrets: <KeyIcon />,
  apis: <ApiIcon />,
  observe: <ObserveIcon />,
  build: <BuildIcon />,
  operate: <OperateIcon />,
};

const answeredHref = (a: Answered) => helpHref({ guide: a.guide, section: a.section });

/**
 * The help's home (board 13a): search, and what people look for, on a dark
 * band; the first four guides for someone new; then by what you're trying
 * to do, each task's questions answered by a guide's section; and the
 * reference. A link shows only when this console serves its guide.
 */
function HelpHome({ categories, served }: { categories: Category[]; served: ReadonlySet<string> }) {
  const ask = useAsk();
  const [query, setQuery] = useState("");
  const hits = useGuideSearch(query);
  const pages = new Map(categories.flatMap((c) => pagesOf(c.children).map((p) => [p.key, p])));
  const start = START_HERE.flatMap((s) => {
    const page = pages.get(s.guide);
    return page ? [{ page, blurb: s.blurb }] : [];
  });
  const has = (a: Answered) => served.has(a.guide);
  const first = categories.flatMap((c) => pagesOf(c.children))[0];
  const tasks = TASKS.map((t) => ({ ...t, questions: t.questions.filter(has) })).filter((t) => t.questions.length > 0);
  const popular = POPULAR.filter(has);
  const deeper = IN_DEPTH.filter(has);
  const chip = { display: "inline-flex", alignItems: "center", minHeight: 32, px: 1.5, borderRadius: 999, bgcolor: "sidebar.hoverBg", color: "code.text", fontSize: 13, fontWeight: 500, textDecoration: "none", "&:hover": { bgcolor: "sidebar.activeBg", color: "sidebar.textStrong" } } as const;

  return (
    <Box sx={{ width: "100%", maxWidth: 1240, mx: "auto", display: "flex", flexDirection: "column", gap: 2.75 }}>
      <Box component="section" aria-labelledby="help-title" sx={{ display: "flex", flexDirection: "column", gap: 2, px: { xs: 2.5, sm: 4 }, py: { xs: 2.5, sm: 3.5 }, borderRadius: 3, bgcolor: "sidebar.background", color: "sidebar.text" }}>
        <Box sx={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-end", gap: 2 }}>
          <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75, minWidth: 0, flex: "1 1 320px" }}>
            <Typography id="help-title" component="h1" sx={{ m: 0, fontSize: { xs: 24, sm: 28 }, fontWeight: 600, color: "sidebar.textStrong" }}>
              Help and guides
            </Typography>
            <Typography sx={{ m: 0, fontSize: 14, color: "sidebar.text" }}>
              How to use Vertra, fix what&apos;s stuck, and how it works, for everyone from a new member to the install&apos;s admins.
            </Typography>
          </Box>
          {typeof ask.model === "string" && (
            <Button
              variant="outlined"
              startIcon={<ChatIcon />}
              onClick={() => { ask.open(); }}
              sx={{ bgcolor: "sidebar.hoverBg", borderColor: "sidebar.activeBg", color: "sidebar.textStrong", "&:hover": { bgcolor: "sidebar.activeBg", borderColor: "sidebar.accent" }, "&.Mui-focusVisible": { outlineColor: (t) => t.palette.sidebar.accent } }}
            >
              Ask Vertra instead
            </Button>
          )}
        </Box>
        <Box role="search">
          <SearchField value={query} onChange={setQuery} large />
        </Box>
        {popular.length > 0 && (
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1, alignItems: "center", fontSize: 13 }}>
            <Box component="span" sx={{ color: "sidebar.textMuted" }}>
              People often look for
            </Box>
            {popular.map((p) => (
              <Box key={p.label} component={RouterLink} to={answeredHref(p)} sx={{ ...chip, "&:focus-visible": { outline: "2px solid", outlineColor: "sidebar.accent", outlineOffset: 2 } }}>
                {p.label}
              </Box>
            ))}
          </Box>
        )}
      </Box>

      {hits && <SearchResults query={query} hits={hits} onPick={() => { setQuery(""); }} />}

      {start.length > 0 && (
        <Card component="section" aria-labelledby="start-here" sx={{ px: 2.5, py: 2.25, display: "flex", flexDirection: "column", gap: 1.5 }}>
          <Box sx={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", gap: 1.25 }}>
            <Typography id="start-here" component="h2" sx={{ m: 0, fontSize: 16, fontWeight: 600 }}>
              New here? Start with {start.length === 1 ? "this one" : `these ${["", "", "two", "three", "four"][start.length] ?? String(start.length)}`}
            </Typography>
            <Typography sx={{ fontSize: 13, color: "text.secondary" }}>About an hour, on samples that call no cloud and cost nothing.</Typography>
          </Box>
          <Box component="ol" sx={{ m: 0, p: 0, listStyle: "none", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 1.5 }}>
            {start.map(({ page, blurb }, i) => (
              <li key={page.key}>
                <Box
                  component={RouterLink}
                  to={linkTo(page)}
                  sx={{ display: "flex", gap: 1.5, alignItems: "flex-start", p: 1.5, borderRadius: 2, bgcolor: "background.default", height: "100%", boxSizing: "border-box", textDecoration: "none", color: "text.primary", "&:hover": { bgcolor: "info.light" } }}
                >
                  <Box aria-hidden="true" sx={{ flex: "0 0 26px", height: 26, borderRadius: "50%", bgcolor: "primary.main", color: "primary.contrastText", fontSize: 12, fontWeight: 600, display: "grid", placeItems: "center" }}>
                    {i + 1}
                  </Box>
                  <Box component="span" sx={{ display: "flex", flexDirection: "column", gap: 0.25 }}>
                    <Box component="span" sx={{ fontSize: 14, fontWeight: 500, color: "primary.main" }}>
                      {page.label}
                    </Box>
                    <Box component="span" sx={{ fontSize: 12, color: "text.secondary" }}>
                      {blurb}
                    </Box>
                  </Box>
                </Box>
              </li>
            ))}
          </Box>
        </Card>
      )}

      {tasks.length > 0 && (
        <Box component="section" aria-labelledby="by-task" sx={{ display: "flex", flexDirection: "column", gap: 1.75 }}>
          <Box sx={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", gap: 1.25 }}>
            <Typography id="by-task" component="h2" sx={{ m: 0, fontSize: 18, fontWeight: 600 }}>
              What are you trying to do?
            </Typography>
            {first && (
              <Link component={RouterLink} to={linkTo(first)} underline="hover" sx={{ fontSize: 13 }}>
                All guides, in reading order
              </Link>
            )}
          </Box>
          <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(320px, 100%), 1fr))", gap: 1.75 }}>
            {tasks.map((t) => (
              <Card key={t.id} component="article" sx={{ p: 2.5, display: "flex", flexDirection: "column", gap: 1.25 }}>
                <Box sx={{ display: "flex", gap: 1.5, alignItems: "center" }}>
                  <Box aria-hidden="true" sx={{ flex: "0 0 36px", height: 36, borderRadius: 2, bgcolor: "info.light", color: "primary.main", display: "grid", placeItems: "center", "& svg": { fontSize: 20 } }}>
                    {ICONS[t.id]}
                  </Box>
                  <Typography component="h3" sx={{ m: 0, fontSize: 16, fontWeight: 600 }}>
                    {t.title}
                  </Typography>
                </Box>
                <Typography sx={{ m: 0, fontSize: 13, color: "text.secondary", lineHeight: 1.5 }}>{t.blurb}</Typography>
                <Box component="ul" sx={{ m: 0, p: 0, listStyle: "none", fontSize: 13, display: "flex", flexDirection: "column" }}>
                  {t.questions.map((q) => (
                    <li key={q.label}>
                      <Link component={RouterLink} to={answeredHref(q)} underline="hover" sx={{ display: "flex", alignItems: "center", minHeight: 32 }}>
                        {q.label}
                      </Link>
                    </li>
                  ))}
                </Box>
              </Card>
            ))}
          </Box>
        </Box>
      )}

      <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(320px, 100%), 1fr))", gap: 2 }}>
        <Card component="section" aria-labelledby="every-page" sx={{ p: 2.5, display: "flex", flexDirection: "column", gap: 1.25, fontSize: 13, lineHeight: 1.5 }}>
          <Typography id="every-page" component="h2" sx={{ m: 0, fontSize: 16, fontWeight: 600 }}>
            Help on every page
          </Typography>
          <Box component="span" sx={{ color: "text.secondary" }}>
            The{" "}
            <HelpIcon sx={{ fontSize: 16, verticalAlign: "-0.2em", color: "primary.main" }} aria-label="question mark" role="img" aria-hidden={false} /> link
            beside each page&apos;s title opens the guide for that page, at the right section.
            {typeof ask.model === "string" && " Ask Vertra (in the side menu, or the top bar on a phone) answers from these guides and your catalog, and says which sections it used."}
          </Box>
        </Card>
        {deeper.length > 0 && (
          <Card component="section" aria-labelledby="in-depth" sx={{ p: 2.5, display: "flex", flexDirection: "column", gap: 1, fontSize: 13 }}>
            <Typography id="in-depth" component="h2" sx={{ m: 0, fontSize: 16, fontWeight: 600 }}>
              Reference and in depth
            </Typography>
            <Box sx={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", columnGap: 2 }}>
              {deeper.map((d) => (
                <Link key={d.label} component={RouterLink} to={answeredHref(d)} underline="hover" sx={{ minHeight: 32, display: "flex", alignItems: "center" }}>
                  {d.label}
                </Link>
              ))}
            </Box>
            <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.5 }}>
              Design history is searchable too, marked as why, not how it works now.
            </Typography>
          </Card>
        )}
      </Box>
    </Box>
  );
}

interface Opened {
  current: string | undefined;
  open: Set<string>;
  toggle: (key: string) => void;
  /** Under the page you're on: its sections. */
  here: React.ReactNode;
}

const NAV_ROW = { borderRadius: 1.5, minHeight: 36, py: 0, px: 1.25, fontSize: 13 } as const;

/** A group in the contents: its name opens and closes it, its pages and groups indented under it. */
function NavGroup({ group, depth, ...opened }: Opened & { group: Group; depth: number }) {
  const expanded = opened.open.has(group.key);
  return (
    <Box component="li" sx={{ listStyle: "none" }}>
      <ListItemButton onClick={() => { opened.toggle(group.key); }} aria-expanded={expanded} sx={{ ...NAV_ROW, pl: 0.5 }}>
        <ExpandMoreIcon fontSize="small" sx={{ mr: 0.5, color: "text.secondary", transition: "transform .15s", transform: expanded ? "none" : "rotate(-90deg)" }} />
        <ListItemText primary={group.label} slotProps={{ primary: { sx: { fontWeight: 600, color: "text.primary", fontSize: 13 } } }} />
      </ListItemButton>
      <Collapse in={expanded} unmountOnExit>
        <NavNodes nodes={group.children} depth={depth + 1} {...opened} />
      </Collapse>
    </Box>
  );
}

function NavNodes({ nodes, depth, ...opened }: Opened & { nodes: Node[]; depth: number }) {
  return (
    <List dense disablePadding sx={{ pl: 1.25, mb: 0.75, ...(depth > 0 && { ml: 1, borderLeft: 1, borderColor: "divider" }) }}>
      {nodes.map((n) => {
        if (n.kind === "group") return <NavGroup key={n.key} group={n} depth={depth} {...opened} />;
        const here = n.key === opened.current;
        return (
          <Box component="li" key={n.key} sx={{ listStyle: "none" }}>
            <ListItemButton
              component={RouterLink}
              to={linkTo(n)}
              selected={here}
              aria-current={here ? "page" : undefined}
              sx={{
                ...NAV_ROW,
                color: "text.secondary",
                "&.Mui-selected": { bgcolor: "info.light", color: "info.main", fontWeight: 500, "&:hover": { bgcolor: "info.light" } },
              }}
            >
              <ListItemText
                primary={n.label}
                secondary={n.history && !/history/i.test(n.label) ? "Design history" : undefined}
                slotProps={{ primary: { sx: { fontWeight: "inherit", fontSize: 13 } } }}
              />
            </ListItemButton>
            {here && opened.here}
          </Box>
        );
      })}
    </List>
  );
}

/**
 * The contents down the side (board 13b): the search, the help's home, then
 * each category opening and closing, its docs and groups nested (a long doc
 * is a group of its sections, some of those grouped again). The way to the
 * page you're on is open, and its sections are listed under it.
 */
function DocsNav({ categories, current, here }: { categories: Category[]; current: string | undefined; here: React.ReactNode }) {
  const way = useMemo(() => {
    for (const c of categories) {
      const trail = current ? trailOf(c.children, current) : null;
      if (trail) return [`category:${c.id}`, ...trail.map((g) => g.key)];
    }
    return [];
  }, [categories, current]);
  const [open, setOpen] = useState<Set<string>>(() => new Set(way));
  useEffect(() => {
    setOpen((was) => (way.every((k) => was.has(k)) ? was : new Set([...was, ...way])));
  }, [way]);
  const toggle = (key: string) => {
    setOpen((was) => {
      const now = new Set(was);
      if (now.has(key)) now.delete(key);
      else now.add(key);
      return now;
    });
  };
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
      <NavSearch />
      <List component="nav" aria-label="Docs contents" dense disablePadding>
        <ListItemButton component={RouterLink} to="/docs" sx={{ ...NAV_ROW, minHeight: 40 }}>
          <ListItemText primary="Help home" slotProps={{ primary: { sx: { fontWeight: 600, fontSize: 13, color: "text.primary" } } }} />
        </ListItemButton>
        {categories.map((c) => {
          const key = `category:${c.id}`;
          const expanded = open.has(key);
          return (
            <Box component="li" key={c.id} sx={{ listStyle: "none" }}>
              <ListItemButton onClick={() => { toggle(key); }} aria-expanded={expanded} sx={{ ...NAV_ROW, minHeight: 40 }}>
                <ListItemText primary={c.title} slotProps={{ primary: { sx: { fontWeight: 600, fontSize: 13, color: "text.primary" } } }} />
                <ExpandMoreIcon fontSize="small" sx={{ color: "text.secondary", transition: "transform .15s", transform: expanded ? "rotate(180deg)" : "none" }} />
              </ListItemButton>
              <Collapse in={expanded} unmountOnExit>
                <NavNodes nodes={c.children} depth={0} current={current} open={open} toggle={toggle} here={here} />
              </Collapse>
            </Box>
          );
        })}
      </List>
    </Box>
  );
}

/** On a phone, the contents as one list to choose from, indented as they nest. */
function DocsPicker({ categories, current }: { categories: Category[]; current: string | undefined }) {
  const navigate = useNavigate();
  const options = (nodes: Node[], depth: number): React.ReactNode[] =>
    nodes.flatMap((n) => {
      const indent = "   ".repeat(depth);
      return n.kind === "page"
        ? [<option key={n.key} value={linkTo(n)}>{indent + n.label}</option>]
        : [<option key={n.key} disabled>{indent + n.label}</option>, ...options(n.children, depth + 1)];
    });
  const here = categories.flatMap((c) => pagesOf(c.children)).find((p) => p.key === current);
  return (
    <TextField
      select
      label="Guide"
      size="small"
      value={here ? linkTo(here) : "/docs"}
      onChange={(event) => { void navigate(event.target.value); }}
      slotProps={{ select: { native: true } }}
      sx={{ bgcolor: "background.paper" }}
      fullWidth
    >
      <option value="/docs">Help home</option>
      {categories.map((c) => (
        <optgroup key={c.id} label={c.title}>
          {options(c.children, 0)}
        </optgroup>
      ))}
    </TextField>
  );
}

/** The section scrolled to: the last whose heading is above the top of the window, else the first. */
function useSectionInView(anchors: string[]): string | undefined {
  const [inView, setInView] = useState<string | undefined>(anchors[0]);
  useEffect(() => {
    setInView(anchors[0]);
    if (anchors.length === 0) return;
    let frame = 0;
    const look = () => {
      frame = 0;
      let seen = anchors[0];
      for (const a of anchors) {
        const top = document.getElementById(a)?.getBoundingClientRect().top;
        if (top !== undefined && top <= 120) seen = a;
      }
      setInView(seen);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(look);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    look();
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [anchors]);
  return inView;
}

/** "On this page": a doc's sections, under it in the contents, the one you're reading marked. */
function OnThisPage({ sections }: { sections: { title: string; anchor: string }[] }) {
  const anchors = useMemo(() => sections.map((s) => s.anchor), [sections]);
  const inView = useSectionInView(anchors);
  return (
    <Box component="nav" aria-label="On this page" sx={{ ml: 1.25, mt: 0.75, mb: 1 }}>
      <Typography sx={{ display: "block", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: "text.secondary", ml: 1.5, mb: 0.5 }}>
        On this page
      </Typography>
      <Box component="ul" sx={{ m: 0, p: 0, listStyle: "none", fontSize: 13 }}>
        {sections.map((s) => {
          const reading = s.anchor === inView;
          return (
            <li key={s.anchor}>
              <Link
                href={`#${s.anchor}`}
                underline="none"
                aria-current={reading ? "location" : undefined}
                sx={{
                  display: "block",
                  py: 0.75,
                  pl: 1.5,
                  lineHeight: 1.4,
                  borderLeft: 2,
                  borderColor: reading ? "primary.main" : "divider",
                  color: reading ? "text.primary" : "text.secondary",
                  fontWeight: reading ? 500 : 400,
                  "&:hover": { color: "text.primary" },
                }}
              >
                {s.title}
              </Link>
            </li>
          );
        })}
      </Box>
    </Box>
  );
}

/** What a page is called on its own: a section by its name, a long doc's overview by the doc's. */
const nameOf = (p: Page, groups: Group[]) => (p.section || groups.length === 0 ? p.label : (groups.at(-1)?.label ?? p.label));

/** Previous and next in reading order, at the foot of a page. */
function Onward({ place }: { place: NonNullable<ReturnType<typeof placeOf>> }) {
  const card = (to: { page: Page; category: Category } | undefined, way: "Previous" | "Next") => {
    if (!to) return <Box />;
    const groups = trailOf(to.category.children, to.page.key) ?? [];
    return (
      <Card sx={{ "&:hover": { borderColor: "primary.main" } }}>
        <CardActionArea component={RouterLink} to={linkTo(to.page)} sx={{ px: 2.25, py: 2, display: "flex", flexDirection: "column", alignItems: way === "Next" ? "flex-end" : "flex-start", gap: 0.5, textAlign: way === "Next" ? "right" : "left" }}>
          <Typography component="span" sx={{ fontSize: 12, color: "text.secondary", display: "flex", alignItems: "center", gap: 0.75 }}>
            {way === "Previous" && <ArrowBackIcon sx={{ fontSize: 14 }} />}
            {way}
            {way === "Next" && <ArrowForwardIcon sx={{ fontSize: 14 }} />}
          </Typography>
          <Typography component="span" sx={{ fontSize: 15, fontWeight: 500, color: "primary.main" }}>
            {nameOf(to.page, groups)}
          </Typography>
        </CardActionArea>
      </Card>
    );
  };
  return (
    <Box component="nav" aria-label="Previous and next" sx={{ display: "grid", gap: 1.75, gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, mt: 2.5 }}>
      {card(place.previous, "Previous")}
      {card(place.next, "Next")}
    </Box>
  );
}

/** At a guide's foot, when there's a model: ask instead. */
function StillStuck() {
  const ask = useAsk();
  if (typeof ask.model !== "string") return null;
  return (
    <Card sx={{ mt: 4.5, px: 2.5, py: 2.25, display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 1.5, fontSize: 14 }}>
      <span>Still stuck? Ask in your own words; the answer cites the sections it used.</span>
      <Button variant="contained" startIcon={<ChatIcon />} onClick={() => { ask.open(); }}>
        Ask Vertra
      </Button>
    </Card>
  );
}

/** A guide organized by symptom: its symptoms first, each a way to its section. */
function Symptoms({ heading, items }: (typeof SYMPTOMS)[string]) {
  return (
    <Box component="section" aria-labelledby="symptoms" sx={{ mb: 1, p: 2.25, borderRadius: 2.5, bgcolor: "action.hover" }}>
      <Typography id="symptoms" component="h2" sx={{ m: 0, mb: 1.5, fontSize: 14, fontWeight: 600, color: "text.secondary" }}>
        {heading}
      </Typography>
      <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(220px, 100%), 1fr))", gap: 1 }}>
        {items.map((s) => (
          <Box
            key={s.label}
            component="a"
            href={`#${s.section ?? ""}`}
            sx={{ display: "flex", flexDirection: "column", gap: 0.375, px: 1.75, py: 1.5, border: 1, borderColor: "divider", borderRadius: 2, bgcolor: "background.paper", textDecoration: "none", color: "text.primary", minHeight: 44, boxSizing: "border-box", "&:hover": { borderColor: "primary.main" } }}
          >
            <Box component="span" sx={{ fontSize: 14, fontWeight: 500, color: "primary.main" }}>
              {s.label}
            </Box>
            <Box component="span" sx={{ fontSize: 12, color: "text.secondary", lineHeight: 1.4 }}>
              {s.hint}
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

/** A guide's text as the boards set it: a reading column, its first paragraph the lead. */
const PROSE = {
  fontSize: 16,
  lineHeight: 1.7,
  color: "text.primary",
  "& h1": { fontSize: { xs: 28, sm: 34 }, lineHeight: 1.2, fontWeight: 600, letterSpacing: "-0.3px", mt: 0, mb: 1.5 },
  "& h1 + p": { fontSize: 17, color: "text.secondary", mb: 2.5 },
  "& p": { mt: 0, mb: 2 },
  "& h2": { fontSize: 22, lineHeight: 1.35, fontWeight: 600, mt: 5, mb: 1.5 },
  "& h3": { fontSize: 18, fontWeight: 600, mt: 3.5, mb: 1 },
  "& h4": { fontSize: 16, fontWeight: 600, mt: 3, mb: 1 },
  "& h1, & h2, & h3, & h4": { scrollMarginTop: 16 },
  "& hr": { border: 0, borderTop: 1, borderColor: "divider", my: 4 },
  "& ul, & ol": { mt: 0, mb: 2, pl: 3 },
  "& li": { mb: 1 },
  "& a": { color: "primary.main" },
  "& blockquote": { m: 0, my: 2, px: 2, py: 1, borderLeft: 4, borderColor: "primary.main", bgcolor: "action.hover", borderRadius: 1 },
  "& table": { borderCollapse: "collapse", width: "100%", minWidth: 560, fontSize: 14, lineHeight: 1.5 },
  "& .task-list-item": { listStyle: "none", ml: -2.5, pl: "1.45em", textIndent: "-1.45em" },
  "& th": { textAlign: "left", px: 1.5, py: 1.25, fontWeight: 600, fontSize: 13, color: "text.secondary", bgcolor: "background.default", borderBottom: 1, borderColor: "divider" },
  "& td": { textAlign: "left", px: 1.5, py: 1.25, verticalAlign: "top", borderTop: 1, borderColor: "divider", overflowWrap: "anywhere" },
  "& pre": { bgcolor: "code.background", color: "code.text", p: 2, borderRadius: 2, overflowX: "auto", lineHeight: 1.5, mt: 0, mb: 2 },
  "& code": { fontFamily: "fontFamilyMono", fontSize: "0.85em" },
  "& :not(pre) > code": { bgcolor: "action.hover", px: 0.625, py: 0.125, borderRadius: 0.5 },
  "& img": { maxWidth: "100%" },
};

/**
 * Help and guides (boards 13a and 13b): the guides in console/docs/, and the
 * platform's own docs in console/docs/reference/, served by
 * ../../src/rpc/services/guide.ts from the console's image, laid out as one
 * set (./docs/contents.ts). Its home is by task, with search; a guide has
 * the contents beside it with its sections under it, where it sits, and the
 * next one to read at its foot.
 */
export function DocsPage() {
  const { id, section } = useParams();
  const navigate = useNavigate();
  const { hash } = useLocation();
  const [docs, setDocs] = useState<DocSummary[] | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [docError, setDocError] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  const error = listError ?? docError;

  useEffect(() => {
    listDocs()
      .then(setDocs)
      .catch((err: unknown) => {
        setListError(err instanceof ApiError ? err.message : "Failed to load the guides.");
      });
  }, []);

  // A doc is fetched once, whichever of its pages is open. The page stays
  // mounted from guide to guide, so one guide's failure clears when another
  // opens, and a late answer for a guide no longer open is dropped.
  useEffect(() => {
    setDocError(null);
    if (!id || id === API_REFERENCE_ID) return;
    let current = true;
    setLoadingContent(true);
    setContent(null);
    getDoc(id)
      .then((text) => {
        if (current) setContent(text);
      })
      .catch((err: unknown) => {
        if (current) setDocError(err instanceof ApiError ? err.message : "Failed to load this guide.");
      })
      .finally(() => {
        if (current) setLoadingContent(false);
      });
    return () => {
      current = false;
    };
  }, [id]);

  const categories = useMemo(() => (docs ? contentsOf(docs) : []), [docs]);
  const served = useMemo(() => ({ ids: new Set([API_REFERENCE_ID, ...(docs?.map((d) => d.id) ?? [])]), doc: id ?? "" }), [docs, id]);
  const split = !!id && isSplit(categories, id);
  const place = id ? placeOf(categories, id, split ? section : undefined) : null;
  const current = id ? (split && section ? `${id}/${section}` : id) : undefined;
  // What this page shows: a long doc's one section, or a doc whole.
  const shown = !docs || content === null ? null : split ? pageOf(content, section) : content;
  const sections = useMemo(() => (shown ? sectionsOf(shown) : []), [shown]);
  // A guide organized by symptom, shown whole: its symptoms after its lead.
  const symptoms = id && !split ? SYMPTOMS[id] : undefined;
  const intro = symptoms && shown ? pageOf(shown) : null;
  // The contents beside the guide on a wide screen; above it, as a list to pick from, on a phone.
  const theme = useTheme();
  const wide = useMediaQuery(theme.breakpoints.up("md"));

  // A link into a long doc by a heading's anchor (search, the chat agent's
  // sources, a link between docs) opens the page that heading is on; one to
  // a section of a doc shown whole opens the doc.
  useEffect(() => {
    if (!id || !docs || content === null) return;
    if (!split && section) {
      void navigate(`/docs/${id}${hash}`, { replace: true });
      return;
    }
    if (split && !section && hash) {
      const holding = sectionHolding(content, decodeURIComponent(hash.slice(1)));
      if (holding) void navigate(`/docs/${id}/${holding}${hash === `#${holding}` ? "" : hash}`, { replace: true });
    }
  }, [id, section, hash, docs, content, split, navigate]);

  // A new page opens at its top, or at the heading it was linked to.
  useEffect(() => {
    if (shown === null) return;
    const target = hash ? document.getElementById(decodeURIComponent(hash.slice(1))) : null;
    // (Optional calls: a test's DOM has neither.)
    if (target) target.scrollIntoView?.();
    else window.scrollTo?.(0, 0);
  }, [shown, hash]);

  if (error || (docs && docs.length === 0)) {
    return (
      <Box>
        <PageHeader title="Help and guides" />
        {error ? (
          <Alert severity="error">{error}</Alert>
        ) : (
          <Alert severity="info">No guides are available here. They ship inside the console&apos;s image, from console/docs/ in the repo.</Alert>
        )}
      </Box>
    );
  }

  if (!id) {
    return docs ? (
      <HelpHome categories={categories} served={served.ids} />
    ) : (
      <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
        <CircularProgress size={24} aria-label="Loading" />
      </Box>
    );
  }

  const markdown = (text: string) => (
    <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSlug]} components={MARKDOWN_COMPONENTS}>
      {text}
    </Markdown>
  );
  const docGroup = place?.groups.at(-1);
  // A long doc's overview is its last crumb already; any other page adds its own name.
  const ownCrumb = place && !(!place.page.section && docGroup?.key === place.page.doc) ? nameOf(place.page, place.groups) : null;

  return (
    <Box sx={{ width: "100%", maxWidth: 1280, mx: "auto", display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "260px minmax(0, 1fr)" }, gap: { xs: 2, md: 4.5 }, alignItems: "start" }}>
      {wide && (
        <Box sx={{ position: "sticky", top: 16, maxHeight: "calc(100vh - 32px)", overflowY: "auto", pr: 0.5, pb: 2 }}>
          {docs ? (
            <DocsNav categories={categories} current={current} here={id !== API_REFERENCE_ID && sections.length >= 2 ? <OnThisPage sections={sections} /> : null} />
          ) : (
            <Box sx={{ p: 2, display: "flex", justifyContent: "center" }}>
              <CircularProgress size={24} aria-label="Loading" />
            </Box>
          )}
        </Box>
      )}
      <Box sx={{ minWidth: 0, maxWidth: 780 }}>
        {docs && !wide && (
          <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5, mb: 2.5 }}>
            <NavSearch />
            <DocsPicker categories={categories} current={current} />
          </Box>
        )}
        <Breadcrumbs aria-label="Where this is" separator="/" sx={{ mb: 1.25, fontSize: 13, color: "text.secondary" }}>
          <Link component={RouterLink} to="/docs" underline="hover">
            Help and guides
          </Link>
          {place && <Typography sx={{ fontSize: "inherit" }}>{place.category.title}</Typography>}
          {place?.groups.map((g, i) => {
            const first = pagesOf(g.children)[0];
            return first && first.key !== place.page.key ? (
              <Link key={g.key} component={RouterLink} to={linkTo(first)} underline="hover" color="inherit">
                {g.label}
              </Link>
            ) : (
              <Typography key={g.key} sx={{ fontSize: "inherit" }} aria-current={!ownCrumb && i === place.groups.length - 1 ? "page" : undefined}>
                {g.label}
              </Typography>
            );
          })}
          {ownCrumb && (
            <Typography sx={{ fontSize: "inherit" }} aria-current="page">
              {ownCrumb}
            </Typography>
          )}
        </Breadcrumbs>
        <Box component="article">
          {id === API_REFERENCE_ID && <ApiReference />}
          {id !== API_REFERENCE_ID && (loadingContent || !docs || content === null) && (
            <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
              <CircularProgress size={24} aria-label="Loading" />
            </Box>
          )}
          {id !== API_REFERENCE_ID && !loadingContent && docs && content !== null && shown === null && (
            <Alert severity="info">
              This guide has no such section now. <Link component={RouterLink} to={`/docs/${id}`}>Its first page</Link> lists what it has.
            </Alert>
          )}
          {id !== API_REFERENCE_ID && !loadingContent && shown !== null && (
            <Served.Provider value={served}>
              {symptoms && intro !== null && (
                <>
                  <Box sx={PROSE}>{markdown(intro)}</Box>
                  <Symptoms heading={symptoms.heading} items={symptoms.items.filter((s) => sections.some((h) => h.anchor === s.section))} />
                </>
              )}
              <Box sx={PROSE}>
                {markdown(symptoms && intro !== null ? shown.slice(intro.length) : shown)}
                {split && !section && place && <SectionList place={place} />}
              </Box>
            </Served.Provider>
          )}
        </Box>
        {id !== API_REFERENCE_ID && <StillStuck />}
        {place && <Onward place={place} />}
      </Box>
    </Box>
  );
}

/** A long doc's first page ends with what's in it: its pages, as the contents group them. */
function SectionList({ place }: { place: NonNullable<ReturnType<typeof placeOf>> }) {
  const doc = place.groups.at(-1);
  if (!doc) return null;
  const list = (nodes: Node[]): React.ReactNode => (
    <ul>
      {nodes.map((n) =>
        n.kind === "page" ? (
          n.section ? (
            <li key={n.key}>
              <Link component={RouterLink} to={linkTo(n)}>
                {n.label}
              </Link>
            </li>
          ) : null
        ) : (
          <li key={n.key}>
            <strong>{n.label}</strong>
            {list(n.children)}
          </li>
        ),
      )}
    </ul>
  );
  return (
    <>
      <h2 id="in-this-doc">In this doc</h2>
      {list(doc.children)}
    </>
  );
}
