/**
 * MAINTENANCE PUBLICATION ADMISSIBILITY — one answer to "may this maintenance
 * source publish?", shared by the publisher that would do the publishing and the
 * cohort derivation that reports what was published.
 *
 * THE DEFECT THIS EXISTS FOR, STATED EXACTLY. Two components asked the same
 * question over the same bytes and returned opposite answers:
 *
 *   apply-path-prestate-program.mjs   requires a schemaVersion-2, pre-state-bound
 *                                     manifest, and BLOCKS anything else with
 *                                     MANIFEST_DOES_NOT_BIND_PRESTATE
 *
 *   deriveCanonicalAuthorizedCohort   checked only `manifestResult.valid`, which
 *                                     is true for a V1 manifest, and ADMITTED
 *
 * So a program the canonical publisher would refuse to run still contributed its
 * paths to AUTHORIZED_COHORT — and AUTHORIZED_COHORT is what the final audit
 * subtracts the observed Git delta from. Paths were therefore being excused by an
 * authorization that could not have produced them. The Repair A envelope defect
 * was one instance (VERIFY_PROGRAM_CONSUMPTION said BLOCKED while the cohort said
 * ADMITTED); the two GATE20 schema-v1 manifests were another, worth fourteen
 * paths. Fixing instances is what let the class survive: the class is that the
 * rule existed twice.
 *
 * THE INVARIANT THIS ESTABLISHES. For every maintenance source, exactly one
 * evaluation decides admissibility, and both consumers call it. A contradiction
 * of the form
 *
 *     publisher BLOCK  +  cohort ADMITTED
 *
 * is not detected and reported here — it is made unrepresentable, because there
 * is no second opinion to disagree with.
 *
 * WHAT IS EVALUATED, AND WHY OCCUPANCY IS NOT.
 *
 * Admissibility is derived from IMMUTABLE PUBLICATION EVIDENCE — facts that were
 * fixed when the program ran and cannot be changed by anything that happens
 * afterwards:
 *
 *   - the authority document's own validity and its declared program identity
 *   - the exact manifest schema the canonical publisher requires (V2, pre-state
 *     bound), because a V1 manifest describes a publication the publisher cannot
 *     perform
 *   - the authority <-> manifest digest binding
 *   - the manifest's exact path set: no wildcards, no directories
 *   - the consumption record's coherence with BOTH the authority and the manifest
 *   - the supported operation classes
 *
 * It is explicitly NOT derived from what those paths hold RIGHT NOW. A completed
 * program whose certified outputs a LATER authorized program lawfully rewrote is
 * still a real, consumed program; requiring current occupancy would delete a
 * Gate's own history from its cohort the moment any later maintenance touched the
 * same path. Live pre-state matching belongs to the publisher at publication time
 * — where the bytes are about to move — and is passed in by that caller alone.
 *
 * Pure: no filesystem, no clock. Every input is bytes the caller already read.
 */
import {
  validateMaintenanceAuthorizedPathManifest,
  validateConsumptionRecordCoherence,
  validateGoverningPathPrestateBinding,
  validatePostFreezeMaintenanceAuthorityV2Shape
} from './post-freeze-maintenance-authority.mjs';

export const ADMISSIBILITY_DOCUMENT = 'MAINTENANCE_PUBLICATION_ADMISSIBILITY';

/** The maintenance authority document kind this evaluator governs. */
export const MAINTENANCE_AUTHORITY_DOCUMENT = 'GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY';

/**
 * The authority schema the canonical publisher understands.
 *
 * A schemaVersion-1 AUTHORITY is not merely older — the V2 evaluator is the only
 * one the publisher runs, and it refuses anything else. Sources at V1 are
 * therefore inadmissible rather than invisible: they are reported with a reason,
 * because a source that silently disappears from a derivation is indistinguishable
 * from a source that was never there.
 */
export const SUPPORTED_AUTHORITY_SCHEMA_VERSION = 2;

/** The manifest schema the pre-state publisher requires. */
export const SUPPORTED_MANIFEST_SCHEMA_VERSION = 2;

/**
 * WHICH PUBLISHER GOVERNS A SOURCE — and why the rule is not one rule.
 *
 * The first version of this evaluator required a pre-state-bound manifest of
 * EVERY maintenance source, on the reasoning that apply-path-prestate-program is
 * "the" canonical publisher. That was a real repair pointed at the wrong scope,
 * and the repository said so immediately: it refused GATE20's AGENT_CLOSURE
 * program, whose authority document is byte-pinned by ledger event 81
 * (`authoritySha256`). Upgrading that manifest would move the authority's digest
 * and break an append-only binding — the manifest cannot be changed, ever.
 *
 * Widening the search made the reason plain. EVERY GATE_FINAL_CLOSURE program in
 * the project (GATE14, 15, 16, 17, 19, 20) is ledger-bound and carries a V1
 * manifest, and so does every GATE_EXTERNAL_CONFIRMATION program. They are not
 * stragglers that nobody migrated. They have a DIFFERENT canonical publisher:
 *
 *   authorityPurpose GATE_FINAL_CLOSURE          published by the lifecycle
 *   authorityPurpose GATE_EXTERNAL_CONFIRMATION  orchestrator, via
 *                                                evaluateTransitionAuthority ->
 *                                                evaluatePostFreezeMaintenanceAuthorityV2,
 *                                                which does NOT require pre-state
 *                                                binding
 *
 *   authorityPurpose NORMAL_MAINTENANCE          published by
 *                                                apply-path-prestate-program,
 *                                                which DOES
 *
 * So the invariant D-04 actually needs is not "one rule for every source". It is:
 * every source is judged by exactly the rule ITS OWN canonical publisher applies,
 * and never by a weaker one. A single global rule gets that wrong in one
 * direction or the other — too weak admits programs no publisher could run (the
 * original defect), too strong refuses programs a publisher genuinely did run and
 * whose evidence is immutable (the over-correction).
 *
 * The purpose is not a self-declared convenience field: it is validated by the
 * canonical authority evaluator, it selects different clause sets there, and for
 * closure programs it is additionally pinned through the ledger event that cites
 * the authority. A source cannot pick the weaker publisher by relabelling itself.
 */
export const LIFECYCLE_PUBLISHED_PURPOSES = Object.freeze(['GATE_FINAL_CLOSURE', 'GATE_EXTERNAL_CONFIRMATION']);
export const PRESTATE_PUBLISHED_PURPOSES = Object.freeze(['NORMAL_MAINTENANCE']);

export const PUBLICATION_CLASS_LIFECYCLE_TRANSITION = 'LIFECYCLE_TRANSITION_PUBLISHER';
export const PUBLICATION_CLASS_PATH_PRESTATE_PROGRAM = 'PATH_PRESTATE_PROGRAM_PUBLISHER';
export const PUBLICATION_CLASS_HISTORICAL_LEGACY_V1 = 'HISTORICAL_LEGACY_V1_MAINTENANCE';

/**
 * TWO QUESTIONS, NOT ONE — and conflating them is how the publisher got weakened.
 *
 *   MODE_PUBLICATION  "may this source publish NOW?"      asked by the publisher
 *   MODE_ADMISSION    "did this source lawfully publish?" asked by the cohort
 *
 * Routing the publisher through a single shared evaluator was right, but the
 * first attempt let the evaluator answer both questions the same way — and
 * because the cohort has to keep admitting lawful history, the shared answer
 * drifted toward the permissive one. The result silently removed
 * MANIFEST_DOES_NOT_BIND_PRESTATE from apply-path-prestate-program, which is a
 * live loosening of the CURRENT secure publisher: brand-new V1 maintenance would
 * have become publishable again.
 *
 * The questions are therefore explicit, and they are asymmetric ON PURPOSE:
 *
 *   PUBLICATION is strict without exception. A schemaVersion-2, pre-state-bound
 *   manifest, always. There is no historical escape hatch, because nothing being
 *   published now is historical.
 *
 *   ADMISSION may accept a V1 manifest, but ONLY against an independently
 *   verifiable historical anchor — see below. It is not a relaxation of the
 *   publisher; it is a different question about a different point in time.
 */
export const MODE_PUBLICATION = 'PUBLICATION';
export const MODE_ADMISSION = 'ADMISSION';

/**
 * WHAT ANCHORS A LEGACY V1 SOURCE AS GENUINELY HISTORICAL.
 *
 * "It has a consumption record" is not an anchor — a new source can be written
 * with one. The anchor has to be evidence the source's author could not
 * manufacture in the working tree, and the repository already has exactly that:
 * the committed history. A source whose authority, manifest AND consumption
 * record are all present at the committed base HEAD published before that commit;
 * a source introduced today is not in HEAD and cannot become so without a commit,
 * which is a separate governed act.
 *
 * All ten legacy V1 normal-maintenance programs in this repository satisfy it.
 * A NEW V1 program satisfies none of it, which is precisely the invariant the
 * owner correction requires: existing documents are not self-authorizing.
 */
export const HISTORICAL_ANCHOR_COMMITTED_AT_BASE_HEAD = 'COMMITTED_AT_BASE_HEAD';

/**
 * The publisher that governs this authority, derived from its validated purpose.
 *
 * An ABSENT purpose defaults to NORMAL_MAINTENANCE, because that is exactly what
 * the canonical authority evaluator does with it. Defaulting differently here
 * would be a second opinion about the same field — the precise failure this
 * module exists to remove — and it showed up immediately as a regression: the
 * oldest program on GATE14 declares no purpose, and treating that as unsupported
 * silently dropped forty-one paths from a closed Gate's cohort.
 */
export function resolvePublicationClass(authorityPurpose) {
  const purpose = authorityPurpose ?? 'NORMAL_MAINTENANCE';
  if (LIFECYCLE_PUBLISHED_PURPOSES.includes(purpose)) return PUBLICATION_CLASS_LIFECYCLE_TRANSITION;
  if (PRESTATE_PUBLISHED_PURPOSES.includes(purpose)) return PUBLICATION_CLASS_PATH_PRESTATE_PROGRAM;
  return null;
}

function refusal(reason, detail = null) {
  return { document: ADMISSIBILITY_DOCUMENT, admissible: false, reason, detail, authorizedPaths: [], findings: [{ code: reason, detail }] };
}

/**
 * @param {object}      options.authority          parsed authority document
 * @param {object|null} options.manifest           parsed authorized-path manifest
 * @param {string|null} options.manifestSha256     digest of the manifest FILE as it exists
 * @param {object|null} options.consumption        parsed consumption record, or null if unconsumed
 * @param {boolean}     options.requireConsumption whether an unconsumed source is inadmissible.
 *   The cohort requires it (an unconsumed authority describes work that did not
 *   happen). The publisher does NOT, because at publication time the consumption
 *   record is what the publication is about to create.
 */
/**
 * PRE-PUBLICATION ADMISSION — the seam, and the exactly two questions it changes.
 *
 * Every fact a V2 authority binds is a fact the authority DECLARES. Base HEAD, the
 * ledger prefix, the Gate pre-state, the manifest digest, maxUse — all of it is
 * written by whoever wrote the authority, so the chain terminates in the document
 * being judged. That was survivable while nothing depended on the authority being
 * WANTED by anyone; it stopped being survivable when a manifest was found declaring
 * its own governing Owner documents as `prestate: ABSENT`, which is a publication
 * that writes its own permission slip.
 *
 * So one more question is asked, and only of the current secure publisher:
 *
 *   MODE_PUBLICATION + PATH_PRESTATE_PROGRAM   did an INDEPENDENT Owner act,
 *                                              causally prior and external to this
 *                                              authority, admit exactly this
 *                                              publication?
 *
 *   everything else                            unchanged, byte for byte
 *
 * SCOPE IS THE WHOLE DESIGN HERE, so it is worth being explicit about what is NOT
 * touched. MODE_ADMISSION — the cohort derivation asking "did this source lawfully
 * publish?" — never consults an admission. It must keep admitting completed
 * historical programs, none of which could have carried an admission that did not
 * exist when they ran, and requiring one would delete lawful history from every
 * closed Gate's cohort. LIFECYCLE_TRANSITION publications are not touched either:
 * they are published by the orchestrator under ledger semantics, which is a
 * different publisher with a different governing act.
 *
 * ORDERING IS LOAD-BEARING. The reserved-historical-identity block above returns
 * before this point, so a reserved identity is refused as NOT_PUBLISHABLE and never
 * reaches the admission seam. An admission must not become the second route around
 * a reservation — that shape is precisely the B05 exploit, and it is closed here by
 * order and again inside the resolver, which refuses a reserved identity outright.
 *
 * FAIL-CLOSED, WITH NO DEFAULT-ALLOW. An absent admission is a refusal, not a
 * pass-through. This function is pure and does no I/O, so the caller resolves the
 * admission and hands the result in; a caller that hands in nothing gets
 * PUBLICATION_ADMISSION_ABSENT rather than the benefit of the doubt.
 *
 * @param {object|null} options.publicationAdmission the resolution returned by
 *   `resolveMaintenancePublicationAdmission`. Required in MODE_PUBLICATION for a
 *   PATH_PRESTATE_PROGRAM source; ignored entirely in every other combination.
 */
export function evaluateMaintenanceSourceAdmissibility({
  authority, manifest, manifestSha256, consumption = null, requireConsumption = true,
  mode = MODE_PUBLICATION, publicationAdmission = null,
  // The ONE historical-identity decision, resolved by the caller through
  // `resolveHistoricalIdentityDecision` and passed in so this function stays pure.
  // `{ reserved: false }` — or absent — is the overwhelmingly normal case and
  // changes nothing about how a source is judged.
  historicalIdentity = null
}) {
  if (!authority || typeof authority !== 'object' || Array.isArray(authority)) return refusal('AUTHORITY_ABSENT_OR_UNREADABLE');
  if (authority.document !== MAINTENANCE_AUTHORITY_DOCUMENT) return refusal('AUTHORITY_DOCUMENT_KIND_INVALID', authority.document ?? null);
  if (authority.schemaVersion !== SUPPORTED_AUTHORITY_SCHEMA_VERSION) return refusal('AUTHORITY_SCHEMA_VERSION_UNSUPPORTED', authority.schemaVersion ?? null);

  if (!manifest) return refusal('MANIFEST_ABSENT', authority.authorizedPathManifestPath ?? null);
  if (typeof manifestSha256 !== 'string' || manifestSha256 !== authority.authorizedPathManifestSha256) {
    return refusal('MANIFEST_DIGEST_DRIFTED', authority.authorizedPathManifestPath ?? null);
  }

  // THE CHECK THE COHORT NEVER RAN AT ALL — and the one that actually closes the
  // proven contradiction. Repair A was BLOCKED by VERIFY_PROGRAM_CONSUMPTION with
  // PROHIBITED_OPERATIONS_INVALID, an AUTHORITY-document defect, while the cohort
  // ADMITTED it. The cohort could not have caught that: it examined the manifest
  // and the consumption record, and never evaluated the authority document
  // itself. Running the canonical document evaluator here is what makes the two
  // sides agree about the authority, not merely about its attachments.
  //
  // The drift-independent half only, for the same reason occupancy is excluded:
  // the observation-dependent clauses (live pre-state, R8 absence, sealed-evidence
  // immutability) describe the repository NOW, and a consumed historical program
  // must not become inadmissible because the repository moved on after it ran.
  const authorityShape = validatePostFreezeMaintenanceAuthorityV2Shape(authority);
  if (!authorityShape.valid) return refusal('AUTHORITY_DOCUMENT_INVALID', authorityShape.findings?.[0]?.code ?? null);

  // ---- RESERVED HISTORICAL IDENTITY, DECIDED BEFORE ANY SCHEMA BRANCH ---------
  //
  // THE B05 EXPLOIT, AND WHY THIS BLOCK SITS EXACTLY HERE.
  //
  // The bridge used to be consulted only inside the V1 branch further down. So the
  // attack never went near it: rewrite the legacy V1 manifest into a coherent V2
  // manifest, reseal the authority and the consumption record onto it, keep the
  // same programId — and the source simply is not V1 any more. It sailed down the
  // ordinary V2 path and was admitted on its own merits, and the historical
  // identity had been rewritten rather than bridged.
  //
  // Placing the reservation ABOVE the schema branch is the repair. Once the Owner
  // has ratified that (projectId, gateId, programId) has one specific historical
  // triple, that identity is decided HERE, by identity, before anything looks at a
  // schemaVersion. There is no branch left to fall through to.
  //
  // It is a DEAD END in both directions, and deliberately so:
  //
  //   MODE_PUBLICATION  a reserved identity can never publish, not even with a
  //                     flawless V2 candidate. A historical admission is not a
  //                     licence, and reusing a retired programId as a shortcut is
  //                     exactly what a successor exists to prevent. Evolution takes
  //                     a NEW programId with its own authority, pre-state,
  //                     candidate, publication and consumption.
  //
  //   MODE_ADMISSION    the exact ratified bytes are admitted through the bounded
  //                     bridge; any other bytes BLOCK. Not "fall back to V1
  //                     refusal" — block, naming the identity, because a fallback
  //                     is a second route and a second route is what was exploited.
  //
  // Both consumers of this function get the same answer, so a publisher/cohort
  // disagreement about a reserved identity is unrepresentable rather than merely
  // untested.
  if (historicalIdentity?.reserved === true) {
    if (mode === MODE_PUBLICATION) {
      return refusal('HISTORICAL_IDENTITY_RESERVED_NOT_PUBLISHABLE', authority.programId ?? null);
    }
    if (historicalIdentity.decision !== 'ADMIT_HISTORICAL') {
      return refusal(historicalIdentity.reason ?? 'HISTORICAL_IDENTITY_RESERVED_MISMATCH', historicalIdentity.detail ?? null);
    }
    const manifestForReserved = validateMaintenanceAuthorizedPathManifest(manifest, authority.programId, authority.authorityPurpose);
    if (!manifestForReserved.valid) return refusal('MANIFEST_INVALID', manifestForReserved.findings?.[0]?.code ?? null);
    if (consumption === null || consumption === undefined) {
      if (requireConsumption) return refusal('CONSUMPTION_ABSENT', authority.consumptionRecordPath ?? null);
    } else {
      const reservedFindings = [];
      validateConsumptionRecordCoherence(consumption, authority, manifest, reservedFindings);
      if (reservedFindings.length > 0) return refusal(`CONSUMPTION_INCOHERENT:${reservedFindings[0].code}`, reservedFindings[0].detail ?? null);
    }
    return {
      document: ADMISSIBILITY_DOCUMENT, admissible: true, reason: null, detail: null,
      authorizedPaths: manifestForReserved.authorizedPaths, prestateByPath: manifestForReserved.prestateByPath,
      programId: authority.programId, publicationClass: PUBLICATION_CLASS_HISTORICAL_LEGACY_V1,
      historicalAdmission: {
        bridgeId: historicalIdentity.bridgeId ?? null, bridgePath: historicalIdentity.bridgePath ?? null,
        ratificationPath: historicalIdentity.ratificationPath ?? null, decisionId: historicalIdentity.decisionId ?? null
      },
      consumed: consumption !== null && consumption !== undefined, findings: []
    };
  }

  const publicationClass = resolvePublicationClass(authority.authorityPurpose);
  if (!publicationClass) return refusal('AUTHORITY_PURPOSE_UNSUPPORTED', authority.authorityPurpose ?? null);

  const manifestResult = validateMaintenanceAuthorizedPathManifest(manifest, authority.programId, authority.authorityPurpose);
  if (!manifestResult.valid) return refusal('MANIFEST_INVALID', manifestResult.findings?.[0]?.code ?? null);

  // A declared V2 manifest must genuinely bind pre-state, in EVERY mode. A
  // document that claims the stronger model and does not implement it is invalid
  // on its own terms, whoever is asking.
  if (manifest.schemaVersion === SUPPORTED_MANIFEST_SCHEMA_VERSION && !manifestResult.bindsPrestate) {
    return refusal('MANIFEST_DOES_NOT_BIND_PRESTATE', `schemaVersion ${SUPPORTED_MANIFEST_SCHEMA_VERSION} declared but not bound`);
  }

  // ---- the three classes, decided explicitly -----------------------------
  //
  // LIFECYCLE_TRANSITION (FINAL_CLOSURE / EXTERNAL_CONFIRMATION) is published by
  // the orchestrator under lifecycle authority and ledger semantics, which do not
  // ask for pre-state binding. Its V1 manifests are lawful by construction, and
  // for closure programs the authority document is additionally byte-pinned by
  // the ledger event that cites it — so it could not be upgraded even if one
  // wanted to.
  //
  // PATH_PRESTATE_PROGRAM is the current secure maintenance publisher. V2 and
  // pre-state binding, unconditionally, when the question is publication.
  const resolvedClass = publicationClass;
  if (publicationClass === PUBLICATION_CLASS_PATH_PRESTATE_PROGRAM
      && manifest.schemaVersion !== SUPPORTED_MANIFEST_SCHEMA_VERSION) {
    // ADMISSIBILITY IS THE EXACT BICONDITIONAL OF PUBLISHABILITY.
    //
    // The same refusal in BOTH modes, and the symmetry is the point. A V1
    // normal-maintenance source cannot be published by the only publisher that
    // governs its class, so it cannot be admitted either — otherwise the cohort
    // would be excusing paths that no canonical publication could have produced,
    // which is the entire defect class.
    //
    // An attempt was made to keep such sources admissible against a "committed at
    // base HEAD" anchor. That anchor is real but unreadable here: this evaluator
    // serves a derivation that is forbidden to consult Git, and inside its
    // permitted information set a legacy V1 source is indistinguishable from one
    // written a minute ago. There is therefore no honest way to admit one, and
    // pretending otherwise would mean admitting a source because its documents
    // exist.
    //
    // The cost is accepted and is bounded: every such source belongs to a Gate
    // that is already closed, and none of them authorizes any path in the current
    // delta. They are reported as REFUSED with this reason, never dropped in
    // silence, so the loss of coverage is visible rather than assumed.
    // NO BRIDGE IS CONSULTED HERE ANY MORE. A legacy V1 source is admissible only
    // through an OWNER-RESERVED historical identity, and that is decided above,
    // before any schema branch — see the reservation block. Reaching this line means
    // the source is V1 and its identity was never reserved, which is the ordinary
    // and correct refusal.
    const detail = mode === MODE_PUBLICATION
      ? `schemaVersion ${SUPPORTED_MANIFEST_SCHEMA_VERSION} required for publication`
      : `schemaVersion ${SUPPORTED_MANIFEST_SCHEMA_VERSION} required; no canonical publisher can publish a V1 normal-maintenance program`;
    return refusal(mode === MODE_PUBLICATION ? 'MANIFEST_DOES_NOT_BIND_PRESTATE' : 'LEGACY_V1_NOT_CANONICALLY_PUBLISHABLE', detail);
  }

  // ---- PRE-PUBLICATION ADMISSION, THE ONE NEW GATE ----------------------
  //
  // Scoped to exactly one (mode, class) pair. Written as an explicit conjunction
  // rather than an early return so that the scope is readable as one condition:
  // widening it later requires editing this line, not discovering a fall-through.
  if (mode === MODE_PUBLICATION && publicationClass === PUBLICATION_CLASS_PATH_PRESTATE_PROGRAM) {
    if (!publicationAdmission || typeof publicationAdmission !== 'object') {
      return refusal('PUBLICATION_ADMISSION_ABSENT', authority.programId ?? null);
    }
    if (publicationAdmission.admitted !== true) {
      return refusal('PUBLICATION_ADMISSION_REFUSED', publicationAdmission.reason ?? null);
    }
    // The admission must be for the publisher that is actually about to run. The
    // constant is re-checked rather than imported from the admission module, which
    // consumes nothing from here — a divergence between the two spellings must be a
    // refusal, never a silent match on a string that drifted.
    if (publicationAdmission.publicationClass !== PUBLICATION_CLASS_PATH_PRESTATE_PROGRAM) {
      return refusal('PUBLICATION_ADMISSION_CLASS_MISMATCH', publicationAdmission.publicationClass ?? null);
    }
    if (publicationAdmission.programId !== authority.programId) {
      return refusal('PUBLICATION_ADMISSION_PROGRAM_MISMATCH', publicationAdmission.programId ?? null);
    }
    // PATH AUTHORIZED IS NOT CURRENT BYTES AUTHORIZED, restated at the seam. An
    // admission that claimed standing future-byte permission would convert a
    // one-publication decision into a licence, so it is refused rather than ignored.
    if (publicationAdmission.grantsFutureBytePermission !== false) {
      return refusal('PUBLICATION_ADMISSION_GRANTS_FUTURE_BYTES', authority.programId ?? null);
    }
    if (publicationAdmission.maxUse !== 1) {
      return refusal('PUBLICATION_ADMISSION_MAX_USE_INVALID', String(publicationAdmission.maxUse ?? null));
    }
    // CONTROL 15, the manifest half: no governing document of this admission chain
    // may be declared as something this publication brings into existence.
    const governingFindings = [];
    validateGoverningPathPrestateBinding({
      manifestResult, governingPaths: publicationAdmission.governingPaths, findings: governingFindings
    });
    if (governingFindings.length > 0) {
      return refusal(governingFindings[0].code, governingFindings[0].detail ?? null);
    }
  }

  if (consumption === null || consumption === undefined) {
    if (requireConsumption) return refusal('CONSUMPTION_ABSENT', authority.consumptionRecordPath ?? null);
    return {
      document: ADMISSIBILITY_DOCUMENT, admissible: true, reason: null, detail: null,
      authorizedPaths: manifestResult.authorizedPaths, prestateByPath: manifestResult.prestateByPath,
      programId: authority.programId, publicationClass: resolvedClass, consumed: false, findings: []
    };
  }

  // Coherence is asked of the CANONICAL validator rather than restated. The
  // drift-independent half only: see the header on why occupancy is excluded.
  const consumptionFindings = [];
  validateConsumptionRecordCoherence(consumption, authority, manifest, consumptionFindings, {
    // Only the publisher knows which admission a publication ran under; the cohort
    // derivation validates the citation's shape and nothing more, because a
    // historical receipt legitimately carries none.
    publicationAdmission: mode === MODE_PUBLICATION ? publicationAdmission : null
  });
  if (consumptionFindings.length > 0) {
    return refusal(`CONSUMPTION_INCOHERENT:${consumptionFindings[0].code}`, consumptionFindings[0].detail ?? null);
  }

  return {
    document: ADMISSIBILITY_DOCUMENT, admissible: true, reason: null, detail: null,
    authorizedPaths: manifestResult.authorizedPaths, prestateByPath: manifestResult.prestateByPath,
    programId: authority.programId, publicationClass: resolvedClass, consumed: true, findings: []
  };
}
