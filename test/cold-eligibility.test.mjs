import test from "node:test";
import assert from "node:assert/strict";
import { evaluateColdEligibility, EXPLICIT_REJECTION_REASONS } from "../src/schema.ts";

test("evaluateColdEligibility: rejects protected warm stages regardless of other params", () => {
  for (const stage of ["Interested", "Engaged", "Booked"]) {
    // Explicit rejection attempt
    const res1 = evaluateColdEligibility({
      currentStage: stage,
      followUpCount: 0,
      followUpDue: null,
      isExplicitRejection: true,
    });
    assert.equal(res1.allowed, false);
    assert.equal(
      res1.reason,
      `Schools in "${stage}" stage are protected. Change stage to Contacted first before marking Cold.`,
    );

    // Unresponsive attempt
    const res2 = evaluateColdEligibility({
      currentStage: stage,
      followUpCount: 3,
      followUpDue: "2020-01-01",
    });
    assert.equal(res2.allowed, false);
    assert.equal(
      res2.reason,
      `Schools in "${stage}" stage are protected. Change stage to Contacted first before marking Cold.`,
    );
  }
});

test("evaluateColdEligibility: allows immediate Cold on all explicit rejection reasons (Path A)", () => {
  const reasons = [
    "Not Interested",
    "Explicit Rejection / Not Interested",
    "No Budget / Funding",
    "Timing / Scheduling Conflict",
    "Outside Program Scope / Ineligible",
    "Other (Declined)",
  ];

  for (const reason of reasons) {
    const res = evaluateColdEligibility({
      currentStage: "Not Contacted",
      followUpCount: 0,
      followUpDue: null,
      coldReason: reason,
    });
    assert.equal(res.allowed, true);
    assert.equal(res.reason, "Eligible for Cold status (Explicit rejection / declined by school).");
  }

  // isExplicitRejection flag also allows immediate Cold
  const flagRes = evaluateColdEligibility({
    currentStage: "Contacted",
    followUpCount: 0,
    followUpDue: "2099-12-31",
    isExplicitRejection: true,
  });
  assert.equal(flagRes.allowed, true);
  assert.equal(flagRes.reason, "Eligible for Cold status (Explicit rejection / declined by school).");
});

test("evaluateColdEligibility: enforces 2 unanswered follow-ups for unresponsive path (Path B)", () => {
  // 0 follow-ups
  const res0 = evaluateColdEligibility({
    currentStage: "Contacted",
    followUpCount: 0,
    followUpDue: "2020-01-01",
  });
  assert.equal(res0.allowed, false);
  assert.equal(
    res0.reason,
    "Requires 2 unanswered follow-ups before marking Cold due to no response (currently 0/2), OR select an explicit decline reason.",
  );

  // 1 follow-up
  const res1 = evaluateColdEligibility({
    currentStage: "Contacted",
    followUpCount: 1,
    followUpDue: "2020-01-01",
  });
  assert.equal(res1.allowed, false);
  assert.equal(
    res1.reason,
    "Requires 2 unanswered follow-ups before marking Cold due to no response (currently 1/2), OR select an explicit decline reason.",
  );
});

test("evaluateColdEligibility: enforces expired deadline for unresponsive path (Path B)", () => {
  // No deadline set
  const resNoDate = evaluateColdEligibility({
    currentStage: "Contacted",
    followUpCount: 2,
    followUpDue: null,
    today: "2026-10-26",
  });
  assert.equal(resNoDate.allowed, false);
  assert.equal(
    resNoDate.reason,
    "Response deadline (not set) must pass before marking Cold due to no response.",
  );

  // Future deadline
  const resFuture = evaluateColdEligibility({
    currentStage: "Contacted",
    followUpCount: 2,
    followUpDue: "2026-11-01",
    today: "2026-10-26",
  });
  assert.equal(resFuture.allowed, false);
  assert.equal(
    resFuture.reason,
    "Response deadline (2026-11-01) must pass before marking Cold due to no response.",
  );

  // Current date (today <= followUpDue)
  const resToday = evaluateColdEligibility({
    currentStage: "Contacted",
    followUpCount: 2,
    followUpDue: "2026-10-26",
    today: "2026-10-26",
  });
  assert.equal(resToday.allowed, false);
  assert.equal(
    resToday.reason,
    "Response deadline (2026-10-26) must pass before marking Cold due to no response.",
  );

  // Past deadline (today > followUpDue)
  const resPast = evaluateColdEligibility({
    currentStage: "Contacted",
    followUpCount: 2,
    followUpDue: "2026-10-25",
    today: "2026-10-26",
  });
  assert.equal(resPast.allowed, true);
  assert.equal(
    resPast.reason,
    "Eligible for Cold status (2 unanswered follow-ups completed & deadline passed).",
  );
});
