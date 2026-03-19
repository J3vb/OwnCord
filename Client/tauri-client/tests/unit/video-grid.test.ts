import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createVideoGrid,
  type VideoGridComponent,
} from "../../src/components/VideoGrid";

/** Minimal MediaStream stub for testing. */
function fakeStream(): MediaStream {
  return {} as unknown as MediaStream;
}

describe("VideoGrid", () => {
  let container: HTMLDivElement;
  let grid: VideoGridComponent;

  beforeEach(() => {
    container = document.createElement("div");
    grid = createVideoGrid();
    grid.mount(container);
  });

  afterEach(() => {
    grid.destroy?.();
  });

  it("mount creates a grid container with data-testid", () => {
    const root = container.querySelector("[data-testid='video-grid']");
    expect(root).not.toBeNull();
    expect(root!.classList.contains("video-grid")).toBe(true);
  });

  it("addStream creates video element and username label", () => {
    grid.addStream(1, "Alice", fakeStream());

    const cell = container.querySelector(".video-cell");
    expect(cell).not.toBeNull();
    expect(cell!.getAttribute("data-user-id")).toBe("1");

    const video = cell!.querySelector("video");
    expect(video).not.toBeNull();
    expect(video!.muted).toBe(true);

    const label = cell!.querySelector(".video-username");
    expect(label).not.toBeNull();
    expect(label!.textContent).toBe("Alice");
  });

  it("addStream replaces existing cell for same userId", () => {
    grid.addStream(1, "Alice", fakeStream());
    grid.addStream(1, "Alice-v2", fakeStream());

    const cells = container.querySelectorAll(".video-cell");
    expect(cells.length).toBe(1);
    expect(cells[0]!.querySelector(".video-username")!.textContent).toBe("Alice-v2");
  });

  it("removeStream removes the cell", () => {
    grid.addStream(1, "Alice", fakeStream());
    expect(container.querySelectorAll(".video-cell").length).toBe(1);

    grid.removeStream(1);
    expect(container.querySelectorAll(".video-cell").length).toBe(0);
  });

  it("removeStream nullifies video srcObject", () => {
    const stream = fakeStream();
    grid.addStream(1, "Alice", stream);

    const video = container.querySelector("video")!;
    expect(video.srcObject).toBe(stream);

    grid.removeStream(1);
    // Video was removed from DOM, but we can verify hasStreams is false
    expect(grid.hasStreams()).toBe(false);
  });

  it("hasStreams returns false when empty", () => {
    expect(grid.hasStreams()).toBe(false);
  });

  it("hasStreams returns true when streams are present", () => {
    grid.addStream(1, "Alice", fakeStream());
    expect(grid.hasStreams()).toBe(true);
  });

  describe("grid layout updates correctly for different user counts", () => {
    function getGridColumns(): string {
      const root = container.querySelector(".video-grid") as HTMLElement;
      return root.style.gridTemplateColumns;
    }

    it("1 user: 1fr", () => {
      grid.addStream(1, "Alice", fakeStream());
      expect(getGridColumns()).toBe("1fr");
    });

    it("2 users: 1fr 1fr", () => {
      grid.addStream(1, "Alice", fakeStream());
      grid.addStream(2, "Bob", fakeStream());
      expect(getGridColumns()).toBe("1fr 1fr");
    });

    it("4 users: 1fr 1fr", () => {
      for (let i = 1; i <= 4; i++) {
        grid.addStream(i, `User${i}`, fakeStream());
      }
      expect(getGridColumns()).toBe("1fr 1fr");
    });

    it("5 users: 1fr 1fr 1fr", () => {
      for (let i = 1; i <= 5; i++) {
        grid.addStream(i, `User${i}`, fakeStream());
      }
      expect(getGridColumns()).toBe("1fr 1fr 1fr");
    });

    it("9 users: 1fr 1fr 1fr", () => {
      for (let i = 1; i <= 9; i++) {
        grid.addStream(i, `User${i}`, fakeStream());
      }
      expect(getGridColumns()).toBe("1fr 1fr 1fr");
    });

    it("10 users: 1fr 1fr 1fr 1fr", () => {
      for (let i = 1; i <= 10; i++) {
        grid.addStream(i, `User${i}`, fakeStream());
      }
      expect(getGridColumns()).toBe("1fr 1fr 1fr 1fr");
    });

    it("layout updates when streams are removed", () => {
      for (let i = 1; i <= 5; i++) {
        grid.addStream(i, `User${i}`, fakeStream());
      }
      expect(getGridColumns()).toBe("1fr 1fr 1fr");

      grid.removeStream(5);
      expect(getGridColumns()).toBe("1fr 1fr");
    });
  });

  it("destroy cleans up all elements", () => {
    grid.addStream(1, "Alice", fakeStream());
    grid.addStream(2, "Bob", fakeStream());

    grid.destroy?.();

    expect(container.querySelector(".video-grid")).toBeNull();
    expect(grid.hasStreams()).toBe(false);
  });
});
