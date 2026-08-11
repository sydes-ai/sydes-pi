import { describe, expect, it } from "vitest";
import { repositoryActionForCall } from "../src/telemetry/session-analyzer.js";

const priority = new Set(["pkg/handler/pokedex.go", "pkg/handler/pokedex_test.go"]);
const relevance = new Set(["add", "pokemon", "decode", "respond", "writejson", "newhandler", "pokedex"]);

describe("session analyzer repository actions", () => {
  it("marks an rg search with guided symbols as task relevant", () => {
    const action = repositoryActionForCall(
      {
        id: "1",
        name: "bash",
        turn: 1,
        args: {
          command:
            'rg "AddPokemon|DecodePokemonJSON|RespondWithError|WriteJSON|addPokemon|NewHandler" .'
        }
      },
      "/tmp/repo",
      priority,
      relevance
    );
    expect(action?.type).toBe("search");
    expect(action?.taskRelevant).toBe(true);
  });

  it("does not mark unrelated searches as task relevant", () => {
    const action = repositoryActionForCall(
      {
        id: "2",
        name: "bash",
        turn: 1,
        args: { command: 'rg "unrelated-auth-token" .' }
      },
      "/tmp/repo",
      priority,
      relevance
    );
    expect(action?.type).toBe("search");
    expect(action?.taskRelevant).toBe(false);
  });

  it("classifies read and edit actions against priority files", () => {
    const read = repositoryActionForCall(
      { id: "3", name: "read", turn: 2, args: { path: "/tmp/repo/pkg/handler/pokedex.go" } },
      "/tmp/repo",
      priority,
      relevance
    );
    const edit = repositoryActionForCall(
      { id: "4", name: "edit", turn: 3, args: { path: "/tmp/repo/README.md" } },
      "/tmp/repo",
      priority,
      relevance
    );
    expect(read).toMatchObject({ type: "read", target: "pkg/handler/pokedex.go", taskRelevant: true });
    expect(edit).toMatchObject({ type: "edit", target: "README.md", taskRelevant: false });
  });
});
