import { describe, it, expect } from "vitest";
import { FORMAT_MARKERS, wrapWithMarker } from "./markdownMarkers";

describe("FORMAT_MARKERS", () => {
  it("maps bold, italic and underline to their markdown markers", () => {
    expect(FORMAT_MARKERS).toEqual({ b: "**", i: "*", u: "__" });
  });
});

describe("wrapWithMarker", () => {
  it("wraps the selection and keeps it selected inside the markers", () => {
    expect(wrapWithMarker("hello world", 6, 11, "**")).toEqual({
      value: "hello **world**",
      selectionStart: 8,
      selectionEnd: 13,
    });
  });

  it("wraps a selection in the middle of the text without touching the rest", () => {
    expect(wrapWithMarker("a bc d", 2, 4, "*")).toEqual({
      value: "a *bc* d",
      selectionStart: 3,
      selectionEnd: 5,
    });
  });

  it("inserts the pair around the caret on an empty selection", () => {
    expect(wrapWithMarker("ab", 1, 1, "__")).toEqual({
      value: "a____b",
      selectionStart: 3,
      selectionEnd: 3,
    });
  });

  it("takes the markers off a selection that includes them", () => {
    expect(wrapWithMarker("say **hi** now", 4, 10, "**")).toEqual({
      value: "say hi now",
      selectionStart: 4,
      selectionEnd: 6,
    });
  });

  it("unwraps a selection holding exactly one character between the markers", () => {
    expect(wrapWithMarker("*x*", 0, 3, "*")).toEqual({
      value: "x",
      selectionStart: 0,
      selectionEnd: 1,
    });
  });

  it("wraps a selection that is only the two markers instead of unwrapping", () => {
    expect(wrapWithMarker("****", 0, 4, "**")).toEqual({
      value: "********",
      selectionStart: 2,
      selectionEnd: 6,
    });
  });

  it("wraps a selection that starts and ends with the marker around other markers", () => {
    expect(wrapWithMarker("**a**b**", 0, 8, "**")).toEqual({
      value: "****a**b****",
      selectionStart: 2,
      selectionEnd: 10,
    });
  });

  it("wraps a selection that only ends with the marker", () => {
    expect(wrapWithMarker("word**", 0, 6, "**")).toEqual({
      value: "**word****",
      selectionStart: 2,
      selectionEnd: 8,
    });
  });

  it("wraps a selection that only starts with the marker", () => {
    expect(wrapWithMarker("**word", 0, 6, "**")).toEqual({
      value: "****word**",
      selectionStart: 2,
      selectionEnd: 8,
    });
  });

  it("takes the markers off when they sit just outside the selection", () => {
    expect(wrapWithMarker("**word**", 2, 6, "**")).toEqual({
      value: "word",
      selectionStart: 0,
      selectionEnd: 4,
    });
  });

  it("unwraps outer markers in the middle of a longer text", () => {
    expect(wrapWithMarker("a __b__ c", 4, 5, "__")).toEqual({
      value: "a b c",
      selectionStart: 2,
      selectionEnd: 3,
    });
  });

  it("requires both outside neighbours to be the marker", () => {
    expect(wrapWithMarker("*word", 1, 5, "*")).toEqual({
      value: "**word*",
      selectionStart: 2,
      selectionEnd: 6,
    });
    expect(wrapWithMarker("word*", 0, 4, "*")).toEqual({
      value: "*word**",
      selectionStart: 1,
      selectionEnd: 5,
    });
  });

  it("adds an italic layer instead of tearing a bold pair apart", () => {
    expect(wrapWithMarker("**word**", 2, 6, "*")).toEqual({
      value: "***word***",
      selectionStart: 3,
      selectionEnd: 7,
    });
  });

  it("adds a layer when only the left neighbour is a longer marker", () => {
    expect(wrapWithMarker("**word*", 2, 6, "*")).toEqual({
      value: "***word**",
      selectionStart: 3,
      selectionEnd: 7,
    });
  });

  it("adds a layer when only the right neighbour is a longer marker", () => {
    expect(wrapWithMarker("*word**", 1, 5, "*")).toEqual({
      value: "**word***",
      selectionStart: 2,
      selectionEnd: 6,
    });
  });

  it("unwraps italic from inside a triple run, leaving the bold pair", () => {
    expect(wrapWithMarker("***word***", 3, 7, "*")).toEqual({
      value: "**word**",
      selectionStart: 2,
      selectionEnd: 6,
    });
  });

  it("unwraps bold from inside a triple run, leaving the italic pair", () => {
    expect(wrapWithMarker("***word***", 3, 7, "**")).toEqual({
      value: "*word*",
      selectionStart: 1,
      selectionEnd: 5,
    });
  });

  it("adds a bold layer around an existing double pair of the same marker", () => {
    expect(wrapWithMarker("****word****", 4, 8, "**")).toEqual({
      value: "******word******",
      selectionStart: 6,
      selectionEnd: 10,
    });
  });

  it("measures the run of the marker character on the right with an underscore marker", () => {
    expect(wrapWithMarker("____word____", 4, 8, "__")).toEqual({
      value: "______word______",
      selectionStart: 6,
      selectionEnd: 10,
    });
  });

  it("stops counting the run at a different character", () => {
    expect(wrapWithMarker("x**word**y", 3, 7, "*")).toEqual({
      value: "x***word***y",
      selectionStart: 4,
      selectionEnd: 8,
    });
  });
});
