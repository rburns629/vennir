// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { errorMessage, listChatFeedback, type ChatRating } from "../../api";
import { Mono } from "../../components/Mono";
import { Pill } from "../../components/Pill";
import { when } from "../../time";
import { AdminCard, Aside } from "./parts";

type Shown = "all" | "down" | "up";

const FILTERS: [Shown, string][] = [
  ["all", "All"],
  ["down", "Wrong"],
  ["up", "Good"],
];

/** One rating: the question, what was wrong, and the answer with what it cited. */
function Rating({ r }: { r: ChatRating }) {
  return (
    <Box component="li" sx={{ listStyle: "none", py: 1.5, borderTop: 1, borderColor: "divider", display: "flex", flexDirection: "column", gap: 0.75 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }}>
        <Pill tone={r.rating === "down" ? "error" : "success"}>{r.rating === "down" ? "Wrong" : "Good"}</Pill>
        <Typography variant="caption" color="text.secondary">
          {when(r.createdAt)} · {r.email ?? "a deleted account"}
          {r.team ? ` · ${r.team}` : ""} · <Mono>{r.model}</Mono>
        </Typography>
      </Stack>
      <Typography variant="body2" sx={{ fontWeight: 600, overflowWrap: "anywhere" }}>
        {r.question}
      </Typography>
      {r.comment && (
        <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
          &ldquo;{r.comment}&rdquo;
        </Typography>
      )}
      <Box component="details">
        <Box component="summary" sx={{ cursor: "pointer", fontSize: 13, color: "text.secondary" }}>
          The answer{r.steps.length > 0 ? ` (it used ${[...new Set(r.steps)].join(", ")})` : ""}
        </Box>
        <Box sx={{ "& p": { my: 0.75 }, "& pre": { overflowX: "auto" }, fontSize: 14, overflowWrap: "anywhere" }}>
          <Markdown remarkPlugins={[remarkGfm]}>{r.answer}</Markdown>
        </Box>
        {r.citations.length > 0 && (
          <Box component="ol" sx={{ m: 0, pl: 2.5, fontSize: 13 }} aria-label="Sources">
            {r.citations.map((c) => (
              <li key={c.id}>
                <Link component={RouterLink} to={c.link}>
                  [{c.id}] {c.title} · {c.heading}
                </Link>
              </li>
            ))}
          </Box>
        )}
      </Box>
    </Box>
  );
}

/**
 * What people said about the chat agent's answers (decision 24,
 * Correctness): a wrong one is a doc to fix or a question for the set
 * (console/test/docQuestions.ts). Kept 90 days; the newest 200 shown.
 */
export function ChatTab() {
  const [ratings, setRatings] = useState<ChatRating[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<Shown>("down");

  useEffect(() => {
    listChatFeedback(null)
      .then(setRatings)
      .catch((err: unknown) => { setError(errorMessage(err, "Couldn't load the ratings.")); });
  }, []);

  const counts = useMemo(() => {
    const n: Record<Shown, number> = { all: 0, down: 0, up: 0 };
    for (const r of ratings ?? []) {
      n.all += 1;
      n[r.rating] += 1;
    }
    return n;
  }, [ratings]);

  const rows = (ratings ?? []).filter((r) => shown === "all" || r.rating === shown);

  return (
    <AdminCard title="Chat answers" status={<Aside>Kept 90 days</Aside>}>
        <Typography variant="body2" color="text.secondary">
          What people rated in Ask Vertra, with the question and answer. A wrong answer is usually a doc to fix (the agent answers from the
          docs), or a question to add to the agent&apos;s question set. Kept 90 days.
        </Typography>
        {error && <Alert severity="error">{error}</Alert>}
        <Box role="group" aria-label="Rating" sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}>
          {FILTERS.map(([id, label]) => (
            <Chip
              key={id}
              label={`${label} ${ratings ? String(counts[id]) : ""}`}
              clickable
              aria-pressed={shown === id}
              color={shown === id ? "primary" : "default"}
              variant={shown === id ? "filled" : "outlined"}
              onClick={() => { setShown(id); }}
              sx={{ height: 36 }}
            />
          ))}
        </Box>
        {ratings && rows.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            No ratings like that.
          </Typography>
        )}
        <Box component="ul" sx={{ m: 0, p: 0 }}>
          {rows.map((r) => (
            <Rating key={r.id} r={r} />
          ))}
        </Box>
    </AdminCard>
  );
}
