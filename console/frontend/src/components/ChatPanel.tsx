// SPDX-License-Identifier: MIT
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import IconButton from "@mui/material/IconButton";
import Link from "@mui/material/Link";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { alpha } from "@mui/material/styles";
import type { SxProps, Theme } from "@mui/material/styles";
import AddCommentIcon from "@mui/icons-material/AddCommentOutlined";
import ChatIcon from "@mui/icons-material/ChatBubbleOutlineOutlined";
import CloseIcon from "@mui/icons-material/Close";
import CartIcon from "@mui/icons-material/ShoppingCartOutlined";
import DoneIcon from "@mui/icons-material/TaskAlt";
import ThumbDownIcon from "@mui/icons-material/ThumbDownOutlined";
import ThumbUpIcon from "@mui/icons-material/ThumbUpOutlined";
import { ApiError, errorMessage, askChatStream, rateAnswer, type ChatAnswer } from "../api";
import { useAuth } from "../auth/AuthContext";
import { cart, useCart } from "../cart";
import { ProposedCartLines } from "./ProposedCartLines";

type Turn = { role: "user"; content: string } | ({ role: "assistant"; content: string } & Omit<ChatAnswer, "text">);

const TOOL_NAMES: Record<string, string> = {
  search_docs: "searched the guides",
  read_doc_section: "read a guide",
  find_offerings: "looked in the catalog",
  describe_offering: "read an offering",
  list_team_resources: "looked at what the team has",
  get_run: "looked at a run",
  plan_order: "planned the order",
  propose_cart: "filled a cart",
};

/** The panel's small square buttons (new conversation, close, rating): 40px targets, quiet until hovered. */
const QUIET_BUTTON: SxProps<Theme> = { width: 40, height: 40, borderRadius: 2, color: "text.secondary", "&:hover": { color: "text.primary" } };

const capitalized = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The answer's citations ("[S1]", "[S1, S2]") as links to its sources,
 * numbered as the sources are listed under it. One the answer doesn't list
 * (the console dropped it) goes.
 */
function numberCitations(text: string, citations: ChatAnswer["citations"]): string {
  const number = new Map(citations.map((c, i) => [c.id, i + 1]));
  return text.replace(/\[(S\d+(?:\s*,\s*S\d+)*)\]/g, (_whole, ids: string) =>
    ids
      .split(",")
      .map((id) => id.trim())
      .flatMap((id) => {
        const n = number.get(id);
        return n ? [`[${String(n)}](#source-${id})`] : [];
      })
      .join(""),
  );
}

/** `onLeave`: a link to one of the console's pages is followed, so the panel closes for it. */
function Answer({ turn, onOpenCart, onLeave }: { turn: Extract<Turn, { role: "assistant" }>; onOpenCart: (c: NonNullable<ChatAnswer["cart"]>) => void; onLeave: () => void }) {
  const navigate = useNavigate();
  const looked = [...new Set(turn.steps.map((s) => TOOL_NAMES[s.tool] ?? s.tool))];
  // Each answer's sources have their own ids: a conversation has several lists.
  const prefix = useId().replace(/:/g, "");
  const components = useMemo<Components>(
    () => ({
      a: ({ href, children }) => {
        const cited = href?.startsWith("#source-") ? href.slice("#source-".length) : null;
        if (!cited) {
          // The console's own pages open in it (a reload would lose the conversation).
          // A path on this console: "/" then not another "/" or a "\\" (which browsers read as another host).
          if (href && /^\/(?![/\\])/.test(href)) {
            return (
              <Link href={href} onClick={(e) => { e.preventDefault(); navigate(href); onLeave(); }}>
                {children}
              </Link>
            );
          }
          // Anywhere else is text: an answer's links are the console's, never
          // one the model was handed by what a product or run says.
          return <>{children}</>;
        }
        const target = `${prefix}-${cited}`;
        return (
          <Link
            href={`#${target}`}
            aria-label={`Source ${String(children)}`}
            underline="none"
            onClick={(e) => {
              e.preventDefault();
              document.getElementById(target)?.scrollIntoView?.({ block: "nearest" });
            }}
            sx={{ fontSize: 11, verticalAlign: "super", ml: 0.25, lineHeight: 0 }}
          >
            [{children}]
          </Link>
        );
      },
    }),
    [prefix, navigate, onLeave],
  );
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
      {looked.length > 0 && (
        <Typography variant="caption" color="text.secondary" sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
          <DoneIcon sx={{ fontSize: 15 }} aria-hidden="true" />
          {capitalized(looked.join(", "))}
        </Typography>
      )}
      <Box sx={{ "& p": { my: 0, mb: 1.25 }, "& p:last-child": { mb: 0 }, "& pre": { overflowX: "auto" }, "& :not(pre) > code": { bgcolor: "action.hover", borderRadius: 0.5, px: 0.625, py: 0.125, fontSize: "0.9em" }, overflowWrap: "anywhere" }}>
        <Markdown remarkPlugins={[remarkGfm]} components={components}>
          {numberCitations(turn.content, turn.citations)}
        </Markdown>
      </Box>
      {turn.cart && (
        <Box
          component="section"
          aria-label="Proposed cart"
          sx={{
            border: 1,
            borderColor: (t) => alpha(t.palette.primary.main, 0.25),
            bgcolor: (t) => alpha(t.palette.info.light, 0.5),
            borderRadius: 2.5,
            p: 1.75,
            display: "flex",
            flexDirection: "column",
            gap: 1.25,
          }}
        >
          <Typography sx={{ display: "flex", alignItems: "center", gap: 1, fontSize: 13, fontWeight: 600 }}>
            <CartIcon sx={{ fontSize: 18, color: "primary.main" }} aria-hidden="true" />A cart for {turn.cart.team}
          </Typography>
          <ProposedCartLines cart={turn.cart} />
          <Typography variant="caption" color="text.secondary">
            Nothing is ordered yet: you make its choices and place it.
          </Typography>
          <Button variant="contained" sx={{ alignSelf: "flex-start" }} onClick={() => { if (turn.cart) onOpenCart(turn.cart); }}>
            Open in cart
          </Button>
        </Box>
      )}
      {turn.citations.length > 0 && (
        <Box>
          <Typography component="h3" sx={{ m: 0, mb: 0.75, fontSize: 12, fontWeight: 600, color: "text.secondary", textTransform: "uppercase", letterSpacing: 0.5 }}>
            Sources
          </Typography>
          <Box component="ol" sx={{ m: 0, p: 0, listStyle: "none", fontSize: 13, display: "flex", flexDirection: "column", gap: 0.5 }} aria-label="Sources">
            {turn.citations.map((c, i) => (
              <Box component="li" key={c.id} id={`${prefix}-${c.id}`} sx={{ display: "flex", gap: 1, alignItems: "baseline", scrollMarginTop: 8 }}>
                <Typography component="span" sx={{ fontSize: 12, color: "text.secondary", fontVariantNumeric: "tabular-nums" }}>
                  [{i + 1}]
                </Typography>
                <span>
                  <Link component={RouterLink} to={c.link} underline="hover" onClick={onLeave}>
                    {c.title} ·{" "}
                    <Box component="span" sx={{ color: "text.primary" }}>
                      {c.heading}
                    </Box>
                  </Link>
                  {c.kind === "history" && (
                    <Typography component="span" variant="caption" color="text.secondary">
                      {" "}
                      (design history: why, not how it works now)
                    </Typography>
                  )}
                </span>
              </Box>
            ))}
          </Box>
        </Box>
      )}
    </Box>
  );
}

/** Thumbs up or down on one answer: sent with its question and answer, for the admins. */
function Rate({ question, turn, team, model }: { question: string; turn: Extract<Turn, { role: "assistant" }>; team: string | null; model: string }) {
  const [sent, setSent] = useState<"up" | "down" | null>(null);
  const [asking, setAsking] = useState(false);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function send(rating: "up" | "down"): Promise<void> {
    setError(null);
    try {
      await rateAnswer({ rating, team, question, answer: turn.content, citations: turn.citations, steps: turn.steps.map((s) => s.tool), model, comment: comment.trim() });
      setSent(rating);
      setAsking(false);
    } catch (err) {
      setError(errorMessage(err, "Couldn't send it."));
    }
  }

  if (sent) {
    return (
      <Typography variant="caption" color="text.secondary">
        Thanks: sent to your admins{sent === "down" ? ", to fix" : ""}.
      </Typography>
    );
  }
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
        <Typography variant="caption" color="text.secondary" sx={{ mr: 0.5 }}>
          Right answer?
        </Typography>
        <IconButton aria-label="Good answer" title="Good answer: sends this question and answer to your admins" onClick={() => { void send("up"); }} sx={QUIET_BUTTON}>
          <ThumbUpIcon fontSize="small" />
        </IconButton>
        <IconButton aria-label="Wrong answer" title="Wrong answer: say what was wrong" onClick={() => { setAsking(true); }} sx={QUIET_BUTTON}>
          <ThumbDownIcon fontSize="small" />
        </IconButton>
      </Box>
      {asking && (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
          <TextField
            size="small"
            multiline
            maxRows={4}
            label="What was wrong?"
            value={comment}
            onChange={(e) => { setComment(e.target.value); }}
            slotProps={{ htmlInput: { maxLength: 2000 } }}
            helperText="Sent with this question and answer to your admins, who fix the docs or the agent."
          />
          <Box sx={{ display: "flex", gap: 1 }}>
            <Button size="small" variant="contained" onClick={() => { void send("down"); }}>
              Send
            </Button>
            <Button size="small" onClick={() => { setAsking(false); }}>
              Cancel
            </Button>
          </Box>
        </Box>
      )}
      {error && <Alert severity="error">{error}</Alert>}
    </Box>
  );
}

/**
 * The chat agent's panel (decision 24): ask about Vennir and get answers
 * from its docs (cited, each linked to its section), or say what you need
 * and get a cart to open and place yourself. The conversation is kept on
 * this page only; each question sends it whole (ChatService/Ask keeps
 * nothing), so it's bounded by the model's context window: the panel says
 * when it's filling, and offers a new one.
 */
export function ChatPanel({
  model,
  width,
  question,
  inputRef,
  onClose,
}: {
  model: string;
  width: { xs: string; sm: number };
  /** The question box, for the panel's opener to focus. */
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  /** A question a page opened the panel with: put in the box, for the person to send or change, or sent at once (`send`). */
  question?: { text: string; send: boolean } | null;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const teams = user?.teamNames ?? [];
  const cartTeam = useCart().team;
  const [team, setTeam] = useState<string>(() => (cartTeam && teams.includes(cartTeam) ? cartTeam : (teams[0] ?? "")));
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; tooLong: boolean } | null>(null);
  // What it's done so far for the question it's answering.
  const [doing, setDoing] = useState<string[]>([]);
  const asking = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const teamId = useId();
  const last = turns.at(-1);
  const full = last?.role === "assistant" ? last.contextPercent : 0;

  function startOver(): void {
    asking.current?.abort();
    setTurns([]);
    setError(null);
  }

  useEffect(() => {
    if (!question) return;
    // Sent at once unless one is being answered: then it waits in the box, never dropped.
    if (question.send && !busy) void send(question.text);
    else {
      setDraft(question.text);
      inputRef?.current?.focus();
    }
    // send changes every render; only a new question should ask.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question]);

  // Leaving the page stops a question in flight: no more model calls for it.
  useEffect(() => () => asking.current?.abort(), []);

  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [turns, busy, doing]);

  async function send(text: string = draft): Promise<void> {
    const question = text.trim();
    if (!question || busy) return;
    const next: Turn[] = [...turns, { role: "user", content: question }];
    setTurns(next);
    setDraft("");
    setBusy(true);
    setError(null);
    setDoing([]);
    const controller = new AbortController();
    asking.current = controller;
    try {
      const answer = await askChatStream(
        team || null,
        next.map((t) => ({ role: t.role, content: t.content })),
        (step) => {
          const said = TOOL_NAMES[step.tool] ?? step.tool;
          setDoing((d) => (d.includes(said) ? d : [...d, said]));
        },
        controller.signal,
      );
      setTurns([...next, { role: "assistant", ...answer, content: answer.text }]);
    } catch (err) {
      // Started over: the question went with the conversation.
      if (controller.signal.aborted) return;
      // The question stays in the box to ask again (or in a new conversation).
      setTurns(turns);
      setDraft(question);
      setError({ message: errorMessage(err, "Couldn't get an answer."), tooLong: err instanceof ApiError && err.code === "CONVERSATION_TOO_LONG" });
    } finally {
      if (asking.current === controller) {
        asking.current = null;
        setBusy(false);
      }
    }
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <Box sx={{ width, maxWidth: "100vw", height: "100%", display: "flex", flexDirection: "column" }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, pl: 2.5, pr: 2, pt: 1.75, pb: 1.5, borderBottom: 1, borderColor: "divider" }}>
        <Box aria-hidden="true" sx={{ flex: "0 0 32px", height: 32, borderRadius: 2, bgcolor: "info.light", color: "primary.main", display: "grid", placeItems: "center" }}>
          <ChatIcon sx={{ fontSize: 18 }} />
        </Box>
        <Box sx={{ flexGrow: 1, minWidth: 0, ml: 0.5 }}>
          <Typography component="h2" sx={{ m: 0, fontSize: 16, fontWeight: 600 }}>
            Ask Vennir
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap component="div">
            Answers from the guides and your catalog · {model}
          </Typography>
        </Box>
        {turns.length > 0 && (
          <IconButton aria-label="New conversation" title="New conversation" onClick={startOver} sx={QUIET_BUTTON}>
            <AddCommentIcon fontSize="small" />
          </IconButton>
        )}
        <IconButton aria-label="Close" title="Close" onClick={onClose} sx={QUIET_BUTTON}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>
      {teams.length > 1 && (
        <Box sx={{ px: 2.5, py: 1.5, borderBottom: 1, borderColor: "divider", display: "flex", alignItems: "center", gap: 1.25, flexWrap: "wrap", fontSize: 13 }}>
          <Box component="label" htmlFor={teamId} sx={{ color: "text.secondary", whiteSpace: "nowrap" }}>
            For team
          </Box>
          <TextField
            select
            size="small"
            value={team}
            onChange={(e) => { setTeam(e.target.value); }}
            slotProps={{ select: { native: true }, htmlInput: { id: teamId } }}
            sx={{ minWidth: 160, maxWidth: 220, "& .MuiInputBase-root": { height: 36, fontSize: 13 } }}
          >
            {teams.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </TextField>
          <Typography variant="caption" color="text.secondary">
            what it looks at, and whose cart
          </Typography>
        </Box>
      )}
      <Box sx={{ flexGrow: 1, overflowY: "auto", px: 2.5, py: 2.25, display: "flex", flexDirection: "column", gap: 2, fontSize: 14, lineHeight: 1.6 }} aria-live="polite">
        {turns.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            Ask how something works (&ldquo;how do I give my product a secret?&rdquo;), or say what you need (&ldquo;app hosting on GCP for shop-api&rdquo;):
            it looks in the guides, your catalog and what your team already has, and fills a cart for you to place.
          </Typography>
        )}
        {turns.map((t, i) =>
          t.role === "user" ? (
            <Box key={i} sx={{ alignSelf: "flex-end", bgcolor: "info.light", color: "text.primary", px: 1.75, py: 1.25, borderRadius: "12px 12px 4px 12px", maxWidth: "85%", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {t.content}
            </Box>
          ) : (
            <Box key={i} sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
              <Answer
                turn={t}
                onLeave={onClose}
                onOpenCart={(c) => {
                  cart.replace(c.team, c.actions, c.choices, c.values);
                  navigate("/catalog/cart");
                  // The cart is the page now; the conversation stays for Ask.
                  onClose();
                }}
              />
              <Rate question={turns[i - 1]?.content ?? ""} turn={t} team={team || null} model={model} />
            </Box>
          ),
        )}
        {busy && (
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, color: "text.secondary" }}>
            <CircularProgress size={16} />
            <Typography variant="body2">{doing.length > 0 ? `It's ${doing.join(", ")}…` : "Thinking… a model can take a minute to answer."}</Typography>
          </Box>
        )}
        {error && (
          <Alert
            severity="error"
            action={
              error.tooLong ? (
                <Button color="inherit" size="small" onClick={startOver}>
                  New conversation
                </Button>
              ) : undefined
            }
          >
            {error.message}
          </Alert>
        )}
        {!error && full >= 75 && (
          <Typography variant="caption" color="text.secondary">
            This conversation is {full}% of what the model can take: start a new one soon.
          </Typography>
        )}
        <div ref={end} />
      </Box>
      <Box component="form" onSubmit={(e) => { e.preventDefault(); void send(); }} sx={{ px: 2, pt: 1.5, pb: 2, borderTop: 1, borderColor: "divider", display: "flex", flexDirection: "column", gap: 1 }}>
        <Box sx={{ display: "flex", gap: 1, alignItems: "flex-end" }}>
          <TextField
            multiline
            minRows={2}
            maxRows={5}
            size="small"
            fullWidth
            placeholder="Ask, or say what you need"
            slotProps={{ htmlInput: { "aria-label": "Your question", maxLength: 4000 } }}
            inputRef={inputRef}
            value={draft}
            onChange={(e) => { setDraft(e.target.value); }}
            onKeyDown={onKey}
          />
          <Button type="submit" variant="contained" size="large" disabled={busy || !draft.trim()}>
            Send
          </Button>
        </Box>
        <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.5 }}>
          It reads what you may see and fills carts; it never runs anything. Enter sends, Shift+Enter starts a new line.
        </Typography>
      </Box>
    </Box>
  );
}
