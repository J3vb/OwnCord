import { expect, test } from "vitest";

test("browser environment is available", () => {
  expect(typeof window).toBe("object");
  expect(typeof document).toBe("object");
  expect(typeof document.createElement).toBe("function");
});

test("real DOM APIs work", () => {
  const div = document.createElement("div");
  div.innerHTML = "<span>hello</span>";
  document.body.appendChild(div);

  const span = document.querySelector("span");
  expect(span).not.toBeNull();
  expect(span!.textContent).toBe("hello");

  div.remove();
});
