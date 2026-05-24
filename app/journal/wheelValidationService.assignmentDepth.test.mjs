import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyAssignmentDepth,
  enrichWithAssignmentDepthFields,
  summarizeAssignmentDepthCounts,
} from "./wheelValidationService.js";

test("classifyAssignmentDepth — non assigné → N/D sans warning", () => {
  const result = classifyAssignmentDepth({
    resolution: { resolved: true, assigned: false, expirationClosePrice: 95 },
    strike: { strike: 100 },
  });
  assert.equal(result.assignmentDepthLabel, "N/D");
  assert.equal(result.assignmentDepthPct, null);
  assert.equal(result.assignmentDepthWarning, null);
});

test("classifyAssignmentDepth — assignation proche", () => {
  const result = classifyAssignmentDepth({
    resolution: { resolved: true, assigned: true, underlying_close_at_expiration: 99.2 },
    strike: { strike: 100 },
  });
  assert.equal(result.assignmentDepthClass, "proche");
  assert.equal(result.assignmentDepthLabel, "proche");
  assert.equal(result.assignmentDepthPct, -0.8);
  assert.match(result.assignmentDepthWarning, /exploitable/i);
});

test("classifyAssignmentDepth — assignation modérée", () => {
  const result = classifyAssignmentDepth({
    resolution: { resolved: true, assigned_flag: true, expirationClosePrice: 97 },
    strike: { strike: 100 },
  });
  assert.equal(result.assignmentDepthClass, "moderee");
  assert.equal(result.assignmentDepthLabel, "modérée");
  assert.equal(result.assignmentDepthPct, -3);
});

test("classifyAssignmentDepth — assignation profonde", () => {
  const result = classifyAssignmentDepth({
    assigned: true,
    assignment_strike: 50,
    assignment_price: 45,
  });
  assert.equal(result.assignmentDepthClass, "profonde");
  assert.equal(result.assignmentDepthPct, -10);
  assert.match(result.assignmentDepthWarning, /capital bloqué/i);
});

test("classifyAssignmentDepth — données manquantes", () => {
  const result = classifyAssignmentDepth({
    resolution: { resolved: true, assigned: true },
    strike: { strike: 100 },
  });
  assert.equal(result.assignmentDepthLabel, "N/D");
  assert.equal(result.assignmentDepthWarning, "Données insuffisantes");
});

test("enrichWithAssignmentDepthFields et summarizeAssignmentDepthCounts", () => {
  const enriched = enrichWithAssignmentDepthFields({
    resolution: { assigned: true, underlying_close_at_expiration: 98 },
    strike: { strike: 100 },
  });
  assert.equal(enriched.assignmentDepthClass, "moderee");

  const summary = summarizeAssignmentDepthCounts([
    { resolution: { assigned: true, underlying_close_at_expiration: 99.5 }, strike: { strike: 100 } },
    { resolution: { assigned: true, underlying_close_at_expiration: 90 }, strike: { strike: 100 } },
    { resolution: { assigned: false }, strike: { strike: 100 } },
  ]);
  assert.equal(summary.proche, 1);
  assert.equal(summary.profonde, 1);
  assert.equal(summary.nd, 1);
});
