// SPDX-License-Identifier: MIT
/**
 * The question set (decision 24, Correctness): questions as people ask them,
 * not in the docs' words, each with the sections that answer it ("<guide> ::
 * <heading>", the heading's last part enough). docs.test.ts checks retrieval
 * against it in CI (the answer among the best five); the agent's answers
 * are scored against the same questions, per model, by hand or nightly.
 * Add a question whenever an answer was wrong: the miss it shows is either
 * the search's or a doc's.
 */
export interface DocQuestion {
  question: string;
  /** Any of these sections answers it. */
  answers: string[];
  /**
   * For scoring a model's answers (not CI): what a right answer says, and
   * what a wrong one has said before. Each came from a real miss.
   */
  mustSay?: string[];
  mustNotSay?: string[];
}

export const DOC_QUESTIONS: DocQuestion[] = [
  // Using Vennir
  { question: "how do I get started trying vennir?", answers: ["01-getting-started :: Try Vennir end to end", "01-getting-started :: Six words to know"] },
  { question: "how do I give my product a password or API key?", answers: ["01-getting-started :: Step 4: Give it a secret", "04-secrets-explained :: Step 1 — registering one"] },
  { question: "can I pass one product's output into another?", answers: ["01-getting-started :: Step 5: Chain two products", "07-how-data-moves :: How a value moves from one task to the next"] },
  {
    question: "what is a DAG and why use one",
    answers: [
      "03-what-is-a-dag :: What's a DAG, and why does this whole system revolve around one?",
      "03-what-is-a-dag :: The concept, with no jargon first",
      "reference-architecture :: Glossary",
    ],
  },
  { question: "how is this different from terraform", answers: ["03-what-is-a-dag :: The direct comparison: Terraform"] },
  { question: "can another team read my team's secrets?", answers: ["04-secrets-explained :: How isolation actually works", "reference-security-model :: Who can read a secret"] },
  { question: "where are secret values actually stored", answers: ["04-secrets-explained :: Step 2 — where it actually goes", "reference-security-model :: Where secret values live"] },
  { question: "what happens if a secret gets deleted by accident", answers: ["04-secrets-explained :: If a secret gets wiped, can it come back?"] },
  { question: "how do I pull secrets from GCP Secret Manager", answers: ["02-sync-secrets-gcp :: Sync secrets from GCP Secret Manager", "02-sync-secrets-gcp :: 6. Add the secret, and use it", "reference-security-model :: Syncing secrets from a vault"] },
  { question: "how do I get an API token for my pipeline", answers: ["05-calling-the-api :: 1. Get a token"] },
  { question: "can github actions sign in without storing a token", answers: ["05-calling-the-api :: Or no token at all: sign in from CI", "reference-security-model :: Keyless bots"] },
  { question: "how do I wait for a run to finish from a script", answers: ["05-calling-the-api :: 3. Wait for it to finish"] },
  { question: "get notified when an order finishes instead of polling", answers: ["05-calling-the-api :: Hearing back without polling", "05-calling-the-api :: Every run of your team, for your systems"] },
  {
    question: "how can a storefront place orders",
    answers: ["05-calling-the-api :: Placing orders from another system", "reference-security-model :: Ordering bots"],
    // Qwen3 14B, 2026-10-28: told the storefront to preview first, which an
    // ordering bot may not (ORDERS_ONLY).
    mustSay: ["RunTemplate"],
    mustNotSay: ["PreviewOrder"],
  },
  { question: "what does resource_exhausted 429 mean", answers: ["05-calling-the-api :: Errors", "05-calling-the-api :: Placing orders from another system"] },
  { question: "where does the console store resources it made", answers: ["06-database-schemas :: resources"] },
  {
    question: "how does the product get its inputs inside the container",
    answers: [
      "07-how-data-moves :: 3. kernel-scheduler hands make-name its input as a file",
      "07-how-data-moves :: 4–5. The product reads a file and writes a file",
      "reference-catalog-guide :: The container contract",
      "reference-architecture :: The product contract",
    ],
  },
  { question: "why isn't a failed job retried by kubernetes itself", answers: ["08-under-the-hood :: A Job per attempt, never retried by Kubernetes"] },
  // Writing products
  { question: "how do I write a product.yaml", answers: ["reference-catalog-guide :: `product.yaml`"] },
  { question: "how do I test my product before publishing", answers: ["reference-catalog-guide :: Testing"] },
  { question: "what will CI refuse in my catalog pull request", answers: ["reference-catalog-guide :: What CI blocks"] },
  { question: "I want to change a product other teams already use", answers: ["reference-catalog-guide :: Changing a product other teams use", "reference-catalog-guide :: Versions"] },
  { question: "how do I publish an existing backend through the gateway", answers: ["reference-catalog-guide :: API products (`apis/`)", "reference-operations :: The API gateway"] },
  { question: "how do I onboard a new team to the catalog", answers: ["reference-catalog-guide :: Onboarding a team", "reference-catalog-onboarding-with-ai :: Onboarding a team or product, with an AI assistant"] },
  { question: "who has to approve changes to my team's products", answers: ["reference-catalog-guide :: Who approves what"] },
  { question: "what should a product never print or return", answers: ["reference-catalog-guide :: The container contract", "reference-security-model :: Rules for product authors"] },
  // Running Vennir
  {
    question: "how do I back up the databases",
    answers: ["reference-operations :: Backups"],
    // Qwen 27B, 2026-10-28: joined the chart's backup.enabled to `vennir
    // config set` into a command that doesn't exist. The doc now says it.
    mustSay: ["database.backups.enabled"],
    mustNotSay: ["config set -e <env> backup.enabled"],
  },
  { question: "how do I upgrade to a new version", answers: ["reference-operations :: Upgrading"] },
  { question: "install vennir on a cluster with helm", answers: ["reference-operations :: Installing on a cluster with Helm", "reference-setup :: 2. `vennir apply <env>`"] },
  { question: "how do I set up HTTPS for the console", answers: ["reference-operations :: HTTPS for the console"] },
  {
    question: "let people sign in with their google accounts",
    answers: ["reference-operations :: Signing in with Google", "reference-security-model :: Signing in", "reference-setup :: 3. Sign in, and invite people"],
    // Qwen3 14B, 2026-10-28: invented where to require it ("Admin > People")
    // under a genuine citation; it's on the team's page.
    mustSay: ["vennir sso google"],
    mustNotSay: ["Admin > People"],
  },
  { question: "the scheduler is slow, steps start late", answers: ["reference-operations :: Throughput", "reference-operations :: Troubleshooting"] },
  { question: "which pods can talk to postgres", answers: ["reference-operations :: Network policies"] },
  { question: "where are the metrics and alerts", answers: ["reference-operations :: Metrics and alerts"] },
  { question: "how do I prepare a new AWS account", answers: ["reference-clouds-aws :: Getting AWS ready for Vennir", "reference-clouds-aws :: An account"] },
  { question: "what do I need in google cloud before installing", answers: ["reference-clouds-gcp :: Getting Google Cloud ready for Vennir", "reference-clouds-gcp :: A project, with billing"] },
  // How it works
  { question: "what guarantees does execution have, can a step run twice", answers: ["reference-architecture :: Guarantees and their limits"] },
  { question: "what parts make up vennir", answers: ["reference-architecture :: The pieces", "reference-architecture :: What Vennir is"] },
  { question: "who can delete something a run made", answers: ["reference-security-model :: What a run made, and deleting it"] },
  { question: "what security checks aren't enforced yet", answers: ["reference-security-model :: Not yet enforced"] },
  // The console's own guides (10-16)
  { question: "the catalog says not ready, can I still run it?", answers: ['10-ordering-and-the-cart :: What does "Not ready" mean on a product?'] },
  { question: "how do I run several actions together as one order?", answers: ["10-ordering-and-the-cart :: How do I order several actions together with the cart?", "05-calling-the-api :: Wiring a cart of actions"] },
  { question: "how do I delete the project my run created?", answers: ["10-ordering-and-the-cart :: Where do I find what a run made, and how do I delete it?", "reference-security-model :: What a run made, and deleting it"] },
  { question: "how do I get access to another team's API?", answers: ["11-apis :: How do I get access to an API?"] },
  { question: "how do I take my API offline during an incident", answers: ["11-apis :: Pausing an API during an incident"] },
  { question: "my product's image failed the security scan, what do I do?", answers: ["12-observe :: What to do when a scan fails", "12-observe :: Image scans, for admins", "16-admin-settings :: Image scans"] },
  { question: "why can't I see another team's logs in Observe?", answers: ["12-observe :: Whose logs can I see?"] },
  { question: "what's the difference between a maintainer and a member?", answers: ["13-teams-and-roles :: What may a member, a maintainer and an admin do?", "01-getting-started :: Members and maintainers"] },
  { question: "can I undo deleting a team?", answers: ["13-teams-and-roles :: What does purging a team do?", "13-teams-and-roles :: What does retiring a team do?"] },
  { question: "how do I rotate my pipeline's vennir token before it expires?", answers: ["14-bots-and-automation :: How long does a token last, and how do I rotate it?", "05-calling-the-api :: 1. Get a token"] },
  { question: "how do I get slack messages when a run fails?", answers: ["14-bots-and-automation :: How do I get my team's notifications in chat?", "reference-security-model :: Notifications and chat webhooks"] },
  { question: "my run failed, where do I look first?", answers: ["15-troubleshooting :: Where do I start when a run fails?", "01-getting-started :: When something goes wrong"] },
  { question: "my step can't read its secret file", answers: ["15-troubleshooting :: My step doesn't get its secret"] },
  { question: "I merged my product but it doesn't show up in the console", answers: ["15-troubleshooting :: The catalog isn't syncing"] },
  { question: "how do I let tasks run images from docker hub?", answers: ["16-admin-settings :: Image sources"] },
  { question: "how do I map our okta groups to teams?", answers: ["16-admin-settings :: Single sign-on and groups", "13-teams-and-roles :: How do single sign-on groups decide who is in a team?"] },
];
