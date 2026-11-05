import { describe, expect, it } from "vitest";

import { isReadable } from "./foryou-lab";

const post = (content, language = null) => ({ content, language });

describe("isReadable", () => {
  it("keeps English and Spanish by declared language", () => {
    expect(isReadable(post("<p>Hello</p>", "en"))).toBe(true);
    expect(isReadable(post("<p>Hola</p>", "es"))).toBe(true);
    expect(isReadable(post("<p>Hello</p>", "en-US"))).toBe(true);
  });

  it("drops other declared languages", () => {
    expect(isReadable(post("<p>Vereiste Felder</p>", "de"))).toBe(false);
    expect(isReadable(post("<p>Y a un vrai sujet</p>", "fr"))).toBe(false);
  });

  it("keeps Latin text with no declared language", () => {
    expect(isReadable(post("<p>Hello there</p>"))).toBe(true);
  });

  it("drops non-Latin text even when declared English", () => {
    expect(
      isReadable(
        post("<p>笑いで溢れる日々<br>#tokyocameraclub #mastodon</p>", "en"),
      ),
    ).toBe(false);
    expect(isReadable(post("<p>Привет всем, как дела</p>"))).toBe(false);
  });

  it("ignores hashtags, mentions and links when judging script", () => {
    expect(
      isReadable(
        post(
          "<p>空に落ちる https://example.com/abcdefghijk #tokyocameraclub</p>",
        ),
      ),
    ).toBe(false);
    expect(isReadable(post("<p>Nice one @日本語 #東京カメラ部</p>"))).toBe(
      true,
    );
  });

  it("keeps a post with no letters", () => {
    expect(isReadable(post("<p>🎉</p>"))).toBe(true);
  });
});
