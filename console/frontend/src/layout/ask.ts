// SPDX-License-Identifier: MIT
import { createContext, useContext } from "react";

/**
 * Ask Vennir, for any page to offer: its model (undefined while the console
 * is asked, null when no model is set), and opening its panel, with a
 * question already in its box for the person to send or change (a failed
 * run's "Ask Vennir about it"), or sent at once when the person already
 * asked it on the page (`{ send: true }`: Home's Ask box). Outside the app's shell (a test rendering
 * one page) there's none.
 *
 *   const ask = useAsk();
 *   {typeof ask.model === "string" && <Button onClick={() => { ask.open(`Why did run ${id} fail?`); }}>Ask Vennir about it</Button>}
 */
export interface Ask {
  model: string | null | undefined;
  /** False when there's no model to open it for (then nothing was asked). */
  open: (question?: string, options?: { send?: boolean }) => boolean;
}

export const AskContext = createContext<Ask>({ model: null, open: () => false });

export const useAsk = () => useContext(AskContext);
