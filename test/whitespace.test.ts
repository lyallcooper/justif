import { describe, expect, it } from "vitest";
import {
  endWithoutCollapsibleSpaces,
  leadingCollapsibleSpaces,
  trailingCollapsibleSpaces,
} from "../src/dom/whitespace.js";

describe("renderer whitespace boundaries", () => {
  it("trims only normalized collapsible U+0020 spaces", () => {
    expect(leadingCollapsibleSpaces("  text  ")).toBe(2);
    expect(trailingCollapsibleSpaces("  text  ")).toBe(2);
    expect(endWithoutCollapsibleSpaces("  text  ")).toBe(6);
  });

  it("preserves author NBSP and NNBSP at painted edges", () => {
    expect(leadingCollapsibleSpaces("\u00A0\u202F text")).toBe(0);
    expect(trailingCollapsibleSpaces("text \u00A0\u202F")).toBe(0);
    expect(endWithoutCollapsibleSpaces("text\u00A0\u202F ")).toBe(6);
  });
});
