// @vitest-environment jsdom
// SPDX-License-Identifier: MIT
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddSecretFlow } from "./AddSecretFlow";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A browser that can mask a textarea (-webkit-text-security), or not (Firefox). */
const browser = (canMask: boolean) => { vi.stubGlobal("CSS", { supports: (property: string) => canMask && property === "-webkit-text-security" }); };

function openDetails() {
  render(<AddSecretFlow teamName="payments" stores={[]} onConnect={() => {}} onClose={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  return screen.getByLabelText("Value") as HTMLTextAreaElement;
}

describe("a pasted secret's value", () => {
  it("is hidden as it's typed, never spell-checked or remembered, and shown only when asked", () => {
    browser(true);
    const value = openDetails();
    expect(value.tagName).toBe("TEXTAREA");
    expect(value.getAttribute("spellcheck")).toBe("false");
    expect(value.getAttribute("autocomplete")).toBe("off");
    expect(value.getAttribute("autocorrect")).toBe("off");
    expect(value.getAttribute("autocapitalize")).toBe("off");
    expect(screen.getByText("Hidden as you paste, and never spell-checked or suggested. Kept encrypted; nobody can read it back here.")).toBeTruthy();

    // Masked by the textarea's style (jsdom keeps the rule, not its effect).
    const masked = () => [...document.querySelectorAll("style")].some((s) => /textarea\{[^}]*-webkit-text-security:disc/.test(s.textContent.replace(/\s/g, "")));
    expect(masked()).toBe(true);
    const toggle = screen.getByRole("button", { name: "Show" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.change(value, { target: { value: '{\n  "type": "service_account"\n}' } });
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Hide" }).getAttribute("aria-pressed")).toBe("true");
    // Shown, it no longer says it's hidden.
    expect(screen.getByText("Never spell-checked or suggested. Kept encrypted; nobody can read it back here.")).toBeTruthy();
    // Shown or hidden, it's the same text, still on several lines.
    expect((screen.getByLabelText("Value") as HTMLTextAreaElement).value).toBe('{\n  "type": "service_account"\n}');
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.getByRole("button", { name: "Show" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("says so where the browser can't hide it, and offers no Show", () => {
    browser(false);
    const value = openDetails();
    expect(value.getAttribute("spellcheck")).toBe("false");
    expect(screen.queryByRole("button", { name: "Show" })).toBeNull();
    expect(screen.getByText("This browser can't hide it as you paste. It's never spell-checked or suggested. Kept encrypted; nobody can read it back here.")).toBeTruthy();
  });
});
