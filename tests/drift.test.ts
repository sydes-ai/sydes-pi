import { describe, expect, it } from "vitest";
import {
  analyzeChangeSurfaceDrift,
  buildChangeSurfaceGuidance,
  shouldInjectDriftWarning
} from "../src/policy/drift.js";
import type { RelevantContext, SourceSymbolRange } from "../src/policy/types.js";

describe("change-surface drift", () => {
  it("keeps a task-relevant symbol modification at none/low", () => {
    const drift = analyzeChangeSurfaceDrift({
      relevantContext: context(),
      diffText: minimalDiff(),
      sourceSymbols: symbols()
    });
    expect(["none", "low"]).toContain(drift.severity);
    expect(drift.unexpectedChangedSymbols).toHaveLength(0);
  });

  it("flags unrelated test symbol deletions as high drift", () => {
    const drift = analyzeChangeSurfaceDrift({
      relevantContext: context(),
      diffText: badDiff(),
      sourceSymbols: symbols()
    });
    expect(drift.severity).toBe("high");
    expect(drift.unexpectedChangedSymbols.map((symbol) => symbol.name)).toEqual(
      expect.arrayContaining(["Test_GetAll", "Test_GetById", "Test_UpdatePokemon"])
    );
    expect(buildChangeSurfaceGuidance(drift)).toContain("[Sydes change-surface warning]");
  });

  it("does not inject duplicate or low-severity drift warnings", () => {
    const low = analyzeChangeSurfaceDrift({
      relevantContext: context(),
      diffText: minimalDiff(),
      sourceSymbols: symbols()
    });
    expect(shouldInjectDriftWarning(low, null)).toBe(false);

    const high = analyzeChangeSurfaceDrift({
      relevantContext: context(),
      diffText: badDiff(),
      sourceSymbols: symbols()
    });
    expect(shouldInjectDriftWarning(high, null)).toBe(true);
    expect(shouldInjectDriftWarning(high, high.signature)).toBe(false);
  });

  it("treats formatting-only adjacent relevant changes as low", () => {
    const drift = analyzeChangeSurfaceDrift({
      relevantContext: context(),
      diffText: `diff --git a/pkg/handler/pokedex_test.go b/pkg/handler/pokedex_test.go
--- a/pkg/handler/pokedex_test.go
+++ b/pkg/handler/pokedex_test.go
@@ -30,2 +30,2 @@ func Test_AddPokemon(t *testing.T) {
-			inputString: \`{"name":"Test", "type":["TestType"],"hp":40}\`,
+			inputString: \`{"name":"Test","type":["TestType"],"hp":40}\`,
`,
      sourceSymbols: symbols()
    });
    expect(["none", "low"]).toContain(drift.severity);
  });
});

function context(): RelevantContext {
  return {
    project: "pokemon",
    task: "POST /api/v1/pokemon with hp=0",
    entryPoints: [
      { name: "addPokemon", qualifiedName: "pokemon.pkg.handler.addPokemon", kind: "Method", filePath: "pkg/handler/pokedex.go", startLine: 17 },
      { name: "Test_AddPokemon", qualifiedName: "pokemon.pkg.handler.Test_AddPokemon", kind: "Function", filePath: "pkg/handler/pokedex_test.go", startLine: 17 }
    ],
    relatedSymbols: [],
    files: ["pkg/handler/pokedex.go"],
    tests: ["pkg/handler/pokedex_test.go"],
    relationships: [],
    querySummary: { queryCount: 1, elapsedMs: 1 }
  };
}

function symbols(): SourceSymbolRange[] {
  return [
    { name: "addPokemon", qualifiedName: "pokemon.pkg.handler.addPokemon", kind: "Method", filePath: "pkg/handler/pokedex.go", startLine: 17, endLine: 35 },
    { name: "Test_AddPokemon", qualifiedName: "pokemon.pkg.handler.Test_AddPokemon", kind: "Function", filePath: "pkg/handler/pokedex_test.go", startLine: 17, endLine: 78 },
    { name: "Test_GetAll", qualifiedName: "pokemon.pkg.handler.Test_GetAll", kind: "Function", filePath: "pkg/handler/pokedex_test.go", startLine: 80, endLine: 145 },
    { name: "Test_GetById", qualifiedName: "pokemon.pkg.handler.Test_GetById", kind: "Function", filePath: "pkg/handler/pokedex_test.go", startLine: 147, endLine: 210 },
    { name: "Test_UpdatePokemon", qualifiedName: "pokemon.pkg.handler.Test_UpdatePokemon", kind: "Function", filePath: "pkg/handler/pokedex_test.go", startLine: 212, endLine: 285 },
    { name: "Test_DeletePokemon", qualifiedName: "pokemon.pkg.handler.Test_DeletePokemon", kind: "Function", filePath: "pkg/handler/pokedex_test.go", startLine: 287, endLine: 340 }
  ];
}

function minimalDiff(): string {
  return `diff --git a/pkg/handler/pokedex.go b/pkg/handler/pokedex.go
--- a/pkg/handler/pokedex.go
+++ b/pkg/handler/pokedex.go
@@ -22,2 +23,6 @@ func (h *Handler) addPokemon(w http.ResponseWriter, r *http.Request) {
+	if pokemon.Hp <= 0 {
+		return
+	}
 
diff --git a/pkg/handler/pokedex_test.go b/pkg/handler/pokedex_test.go
--- a/pkg/handler/pokedex_test.go
+++ b/pkg/handler/pokedex_test.go
@@ -48,2 +48,8 @@ func Test_AddPokemon(t *testing.T) {
+		{
+			testName: "HP zero",
+		},
 	}
`;
}

function badDiff(): string {
  return `diff --git a/pkg/handler/pokedex_test.go b/pkg/handler/pokedex_test.go
--- a/pkg/handler/pokedex_test.go
+++ b/pkg/handler/pokedex_test.go
@@ -101,8 +121,0 @@ func Test_GetAll(t *testing.T) {
-		{
-			testName: "Server error. Error",
-		},
@@ -166,8 +177,0 @@ func Test_GetById(t *testing.T) {
-		{
-			testName: "Server error. Error",
-		},
@@ -232,20 +234,0 @@ func Test_UpdatePokemon(t *testing.T) {
-		{
-			testName: "Server error. Error",
-		},
-		{
-			testName: "Server error. Error",
-		},
@@ -302,2 +284,2 @@ func Test_DeletePokemon(t *testing.T) {
-				s.EXPECT().DeletePokemon(1).Return(nil)
+				 s.EXPECT().DeletePokemon(1).Return(nil)
`;
}
