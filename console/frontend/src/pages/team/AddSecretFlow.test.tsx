// @vitest-environment jsdom
// SPDX-License-Identifier: MIT
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AddSecretFlow } from "./AddSecretFlow";

afterEach(cleanup);

describe("a pasted secret's value", () => {
  it("is hidden as it's typed, never spell-checked or remembered, and shown only when asked", () => {
    render(<AddSecretFlow teamName="payments" stores={[]} onConnect={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    const value = screen.getByLabelText("Value") as HTMLTextAreaElement;
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
    // Shown or hidden, it's the same text, still on several lines.
    expect((screen.getByLabelText("Value") as HTMLTextAreaElement).value).toBe('{\n  "type": "service_account"\n}');
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.getByRole("button", { name: "Show" }).getAttribute("aria-pressed")).toBe("false");
  });
});
