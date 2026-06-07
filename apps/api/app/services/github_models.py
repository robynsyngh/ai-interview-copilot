"""P5 - Real-Time Evaluator backed by GitHub Models inference.

Calls `POST {endpoint}/chat/completions` (OpenAI-compatible) with a coach
system prompt. Returns one structured `HintProposal` per call.

Costs / rate-limits are kept in check by the caller, which throttles to one
in-flight call per session (see `routers/live_stream.py`).
"""

from __future__ import annotations

import asyncio
import json
import re
import time
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import httpx
import structlog

from app.config import get_settings
from app.models.hint import HintKind
from app.models.report import Recommendation

log = structlog.get_logger(__name__)

# Process-wide cooldown shared across every evaluator instance (a fresh
# evaluator is created per request). When a provider returns 429 we park it
# until its retry window elapses so subsequent requests skip straight to the
# fallback instead of burning a doomed call on the exhausted provider.
_PROVIDER_COOLDOWN_UNTIL: dict[str, float] = {}


@dataclass(slots=True)
class _Provider:
    """One OpenAI-compatible chat-completions backend (GitHub Models, Gemini, …)."""

    name: str
    client: httpx.AsyncClient
    model: str


def _retry_after_seconds(response: httpx.Response) -> float:
    """Best-effort parse of how long to wait before retrying a 429."""
    header = response.headers.get("retry-after")
    if header:
        try:
            return float(header)
        except ValueError:
            pass
    match = re.search(r"wait\s+(\d+)\s+seconds", response.text, re.IGNORECASE)
    if match:
        return float(match.group(1))
    return 60.0


_SYSTEM_PROMPT = """You are an expert technical interviewer's real-time co-pilot.

You receive:
  1. The job description for the role being interviewed for.
  2. The candidate's resume excerpt.
  3. A short rolling window of the most recent transcript from the live interview.

Your job is to produce ONE concise piece of guidance for the interviewer right now.
The transcript is the source of truth. Use the job description and resume only as
background context; do not summarize or praise the resume/JD unless the recent
transcript explicitly supports it.

Reply with ONLY a single JSON object (no prose, no markdown fences). The object MUST have these keys:
  - "kind": one of
        "follow_up_question"   (suggest a question the interviewer should ask next),
        "clarifying_prompt"    (suggest a phrase to clarify ambiguity),
        "red_flag"             (something concerning the interviewer should probe),
        "strength_signal"      (a strong positive signal worth acknowledging),
        "score_update"         (an overall trajectory note).
  - "content": a 1-2 sentence string addressed to the interviewer (not the candidate).
  - "score_delta": optional number in [-10, +10] representing how much this moment shifts
                   your overall hire/no-hire confidence. Use null when not applicable.

Rules:
  - Prefer an actionable follow-up question grounded in the latest candidate answer.
  - Tie the follow-up to a concrete JD requirement or responsibility whenever possible.
  - Write the question the interviewer should ask next, not analysis about the candidate.
  - Use "strength_signal" only when the candidate gave a concrete, recent example.
  - Do not repeat the same point in different words.
  - If the transcript is thin, noisy, or not yet substantive, ask a short probing question.
  - Never say "aligns with the job description" unless naming the exact transcript evidence.

Good content format:
  "Ask: <one direct interview question>. Why: <one short reason tied to JD or the latest answer>."

Be specific. Reference what was just said. Avoid generic advice."""


_FINAL_REPORT_SYSTEM_PROMPT = """You are an expert technical interviewer writing a final, honest interview evaluation that will be shown to hiring managers.

CRITICAL EVIDENCE RULES (read carefully):
  - The CANDIDATE'S spoken answers in the transcript are the ONLY evidence of how the candidate performed.
  - The job description and resume describe the role and the candidate's CLAIMS. They are NOT evidence that the candidate demonstrated anything in this interview. Never credit the candidate for skills that appear only in the resume/JD.
  - Any "interviewer hints", rubrics, or expected-answer notes are guidance for the interviewer. They describe what a GOOD answer WOULD contain. They are NOT things the candidate actually said. Never attribute hint/rubric content to the candidate.
  - Judge ONLY what the candidate actually said in their transcript turns. If the candidate did not answer a question, that is a gap, not a strength.

SCORING:
  - If the candidate gave little or no substantive answers, scores must be LOW (roughly 0-20) and the recommendation must be "strong_no_hire". Do not be polite or generous.
  - Only give scores above 60 when the candidate's own words contain concrete, correct, relevant content.
  - Every claim in the summary and strengths MUST quote or paraphrase something the candidate actually said.

Reply with ONLY a single JSON object (no prose, no markdown fences) with these keys:
  - "overall_score": number from 0 to 100
  - "technical_score": number from 0 to 100
  - "communication_score": number from 0 to 100
  - "culture_fit_score": number from 0 to 100
  - "summary": 2-4 sentence evidence-based summary grounded ONLY in what the candidate said
  - "strengths": array of 0-5 concise strings (empty array if the candidate gave no real answers)
  - "weaknesses": array of 1-5 concise strings
  - "recommendation": one of "strong_hire", "hire", "no_hire", "strong_no_hire"

If the candidate's transcript is empty or contains no real answers, return low scores, an empty strengths array, and clearly state in the summary that there was not enough evidence to evaluate the candidate."""


_CANDIDATE_HINT_SYSTEM_PROMPT = """You are a real-time interview co-pilot for the CANDIDATE (the interviewee).

You receive:
  1. The job description for the role.
  2. The candidate's resume excerpt.
  3. A short rolling window of the most recent transcript from the live interview.

Your job is to give the candidate ONE concise, actionable cue to improve what they
are saying RIGHT NOW. The transcript is the source of truth.

Reply with ONLY a single JSON object (no prose, no markdown fences) with these keys:
  - "kind": one of
        "clarifying_prompt"  (a short cue for what to add or clarify in the live answer),
        "strength_signal"    (confirm a strong point the candidate just made),
        "follow_up_question" (a likely next question to be ready for),
        "red_flag"           (warn the candidate about a weak/risky thing they just said).
  - "content": a 1-2 sentence cue addressed to the CANDIDATE (e.g. "Add a concrete metric: mention you cut latency by 40%.").
  - "score_delta": optional number in [-10, +10], or null.

Rules:
  - Speak to the candidate ("you"), never to an interviewer.
  - Be specific and tied to what was just said and to the resume/JD.
  - Do not repeat the same point in different words. Avoid generic praise."""


_ANSWER_RUBRIC_SYSTEM_PROMPT = """You are an expert technical interview assistant for the interviewer.

The interviewer just asked a question. Generate a private expected-answer rubric to help the interviewer evaluate the candidate's answer.
Use the job description and resume to make the rubric relevant to this role and candidate.

If the question is a coding / data-structures-&-algorithms / SQL / system-design / logic PROBLEM
(it asks to produce a solution, has Input/Output examples, "write a function/query", etc.), then
"expected_answer" MUST contain the actual correct solution: a one-line optimal approach, the key
steps or a short code/SQL sketch, and the time/space complexity. Do NOT just say "a strong answer
explains the approach" — state the real approach.

Reply with ONLY a single JSON object (no prose, no markdown fences) with these keys:
  - "expected_answer": for problems, the concrete correct solution + complexity; for behavioral
    questions, 2-4 sentences describing what a strong answer should include
  - "listen_for": array of 3-6 key points to listen for (for problems: the essential steps/edge cases)
  - "red_flags": array of 2-4 warning signs (for problems: common wrong approaches, e.g. brute force only, missing dedup)
  - "follow_up": one strong follow-up question the interviewer can ask
  - "score_guidance": one sentence explaining how to score the answer

Keep it practical and short enough to read during a live interview."""


_CANDIDATE_ANSWER_SYSTEM_PROMPT = """You are a real-time interview co-pilot for the CANDIDATE (the interviewee).

The interviewer asked the candidate a question. FIRST, silently classify the question into one of:
  - TECHNICAL_PROBLEM: a coding / data-structures-&-algorithms / SQL / system-design / logic
    problem that has a concrete correct solution. Signals: "write a function/query", "return all ...",
    "given an array/table ...", "implement ...", "design ...", code samples, Input/Output examples,
    or any problem that asks you to PRODUCE a solution.
  - EXPERIENCE: a behavioral / resume / "tell me about a time" / opinion question about the
    candidate's own background, projects, or choices.

Then produce the answer the candidate should give. Answer the question that was ACTUALLY asked.

If TECHNICAL_PROBLEM:
  - SOLVE THE PROBLEM directly and correctly. Do NOT talk about the candidate's resume, past
    projects, or companies. Resume content is irrelevant to a coding/SQL problem.
  - "answer" MUST contain, in this order:
      1) One short line naming the approach (e.g. "Sort, then two-pointer scan").
      2) A clean, correct, idiomatic code (or SQL) solution. Use plain text with normal
         indentation and line breaks (no markdown fences).
      3) A final line with time and space complexity (e.g. "Time: O(n^2), Space: O(1)").
  - Choose the language implied by the question; otherwise default to Python for DSA and
    standard SQL for query questions.
  - "key_points": 2-4 short phrases naming the core ideas (e.g. "sort + two pointers",
    "skip duplicates", "O(n^2) time").

If EXPERIENCE:
  - Produce a first-person spoken answer (about 4-8 sentences) the candidate can say OUT LOUD,
    grounded in concrete resume details (projects, tools, companies, metrics) when available.
  - Sound natural and confident. Do NOT invent fake credentials, employers, or numbers.
  - "key_points": 2-4 short phrases the candidate must be sure to mention.

Reply with ONLY a single JSON object (no prose, no markdown fences) with these keys:
  - "answer": the full answer as described above.
  - "key_points": array of 2-4 short strings.

Rule (critical): NEVER answer a coding/SQL/algorithm/design question with a behavioral or
resume story, and never answer a behavioral question with code."""


_SECTION_QUESTIONS_SYSTEM_PROMPT = """You are a senior technical interviewer building one focused BLOCK of interview questions to GRILL a single candidate on ONE specific topic.

You will be given: the exact topic to test, how many questions to produce, the candidate's experience level, optional topic guidance, and short JD + resume context.

GOAL: expose how deep the candidate's REAL knowledge of this topic is. Start gentle to build rapport, then escalate until only someone with genuine hands-on depth can keep up.

DIFFICULTY RAMP (mandatory): return the questions ordered from EASIEST to HARDEST.
  - First ~30%: "Easy" — core concepts, definitions, basic usage of the topic.
  - Middle ~40%: "Medium" — practical application, common pitfalls, debugging, "what happens if…".
  - Last ~30%: "Hard" — internals, performance/scaling, concurrency/failure modes, design trade-offs, tricky edge cases.

Calibrate the ABSOLUTE difficulty to the candidate's level (junior / mid / senior), but ALWAYS keep the easy→hard ordering inside the block.

Reply with ONLY a single JSON object (no prose, no markdown fences) with this exact shape:
{
  "questions": [
    {"difficulty": "Easy|Medium|Hard", "question": "the full self-contained single-line question"}
  ]
}

Rules:
  - Produce EXACTLY the requested number of questions, ordered easy→hard.
  - Every question MUST be specific to the given topic and name concrete APIs, keywords, or concepts of that topic.
  - Each question is self-contained, answerable on its own, and on a SINGLE line (NO line breaks).
  - For SQL topics, describe the relevant tables and columns inline (e.g. "Given orders(id, user_id, amount, created_at), …").
  - For data-structures/algorithms topics, state the exact input and expected output.
  - Force reasoning, not recall ("why/how does it work", "what breaks if…"). No behavioral or "tell me about yourself" questions. No duplicates."""


# Per-section steering so DSA / SQL / JS-fundamentals blocks cover the right
# ground instead of drifting into generic trivia.
_SECTION_GUIDANCE: dict[str, str] = {
    "Data Structures & Algorithms": (
        "Cover, in increasing difficulty: arrays & strings, hashing, two pointers, sliding window, "
        "stacks/queues, linked lists, binary search, trees & BSTs, graphs (BFS/DFS), recursion/backtracking, "
        "and dynamic programming. For EVERY question give the exact input and expected output, and expect the "
        "candidate to reason about time/space complexity."
    ),
    "JavaScript Fundamentals": (
        "Cover, in increasing difficulty: var/let/const & scope, hoisting, closures, the 'this' keyword & binding, "
        "prototypes & inheritance, type coercion & equality, higher-order functions, the event loop & "
        "microtask/macrotask ordering, promises vs async/await, and memory/closure pitfalls. Prefer 'what does "
        "this snippet print and why' style questions for the harder ones."
    ),
    "SQL": (
        "Cover, in increasing difficulty: SELECT/WHERE filtering, JOIN types, GROUP BY/HAVING, aggregation, "
        "subqueries & CTEs, window functions, indexing & query plans, and query optimization. Describe the "
        "relevant tables and columns inline for every query question."
    ),
}


class HintProposal:
    __slots__ = ("session_id", "kind", "content", "score_delta", "ts")

    def __init__(
        self,
        *,
        session_id: uuid.UUID,
        kind: HintKind,
        content: str,
        score_delta: float | None,
    ) -> None:
        self.session_id = session_id
        self.kind = kind
        self.content = content
        self.score_delta = score_delta
        self.ts = datetime.utcnow()


class FinalReportProposal:
    __slots__ = (
        "overall_score",
        "technical_score",
        "communication_score",
        "culture_fit_score",
        "summary",
        "strengths",
        "weaknesses",
        "recommendation",
    )

    def __init__(
        self,
        *,
        overall_score: float,
        technical_score: float,
        communication_score: float,
        culture_fit_score: float,
        summary: str,
        strengths: list[str],
        weaknesses: list[str],
        recommendation: Recommendation,
    ) -> None:
        self.overall_score = overall_score
        self.technical_score = technical_score
        self.communication_score = communication_score
        self.culture_fit_score = culture_fit_score
        self.summary = summary
        self.strengths = strengths
        self.weaknesses = weaknesses
        self.recommendation = recommendation


class GitHubModelsEvaluator:
    """Chat-completions evaluator with automatic provider failover.

    GitHub Models is the primary backend; Google Gemini (OpenAI-compatible
    endpoint) acts as a fallback when GitHub is rate limited or unreachable.
    Provider order is configurable via ``MODEL_PROVIDER_ORDER``. The class name
    is kept for backwards compatibility with existing imports.
    """

    def __init__(self) -> None:
        self._settings = get_settings()
        self._providers = self._build_providers()

    def _build_providers(self) -> list[_Provider]:
        s = self._settings
        timeout = httpx.Timeout(30.0, connect=10.0)
        base_headers = {"Accept": "application/json", "Content-Type": "application/json"}

        factories = {
            "github": lambda: _Provider(
                name="github",
                model=s.github_models_name,
                client=httpx.AsyncClient(
                    base_url=s.github_models_endpoint,
                    timeout=timeout,
                    headers={**base_headers, "Authorization": f"Bearer {s.github_models_token}"},
                ),
            ),
            "gemini": lambda: _Provider(
                name="gemini",
                model=s.gemini_model,
                client=httpx.AsyncClient(
                    base_url=s.gemini_endpoint,
                    timeout=timeout,
                    headers={**base_headers, "Authorization": f"Bearer {s.gemini_api_key}"},
                ),
            ),
        }
        configured = {"github": bool(s.github_models_token), "gemini": bool(s.gemini_api_key)}

        providers: list[_Provider] = []
        for name in s.provider_order_list:
            if name in factories and configured.get(name):
                providers.append(factories[name]())
        return providers

    @property
    def enabled(self) -> bool:
        return bool(self._providers)

    async def aclose(self) -> None:
        for provider in self._providers:
            await provider.client.aclose()

    async def _complete_json(
        self,
        *,
        messages: list[dict[str, str]],
        max_tokens: int,
        temperature: float = 0.2,
        log_event: str = "completion",
    ) -> dict[str, Any] | None:
        """Call providers in order until one returns parsed JSON content.

        Fails over on 429 (recording a cooldown), 5xx, transport errors, and
        unparseable bodies. Returns the model's JSON object, or ``None`` when
        every provider is exhausted/unavailable.
        """
        if not self._providers:
            log.debug("model_providers_missing", op=log_event)
            return None

        for provider in self._providers:
            cooldown_until = _PROVIDER_COOLDOWN_UNTIL.get(provider.name, 0.0)
            remaining = cooldown_until - time.monotonic()
            if remaining > 0:
                log.debug(
                    "model_provider_cooldown_skip",
                    provider=provider.name,
                    op=log_event,
                    retry_in_s=round(remaining),
                )
                continue

            body = {
                "model": provider.model,
                "messages": messages,
                "temperature": temperature,
                "max_tokens": max_tokens,
                "response_format": {"type": "json_object"},
            }

            try:
                response = await provider.client.post("/chat/completions", json=body)
            except httpx.HTTPError as exc:
                log.warning(
                    "model_request_failed",
                    provider=provider.name,
                    op=log_event,
                    error=str(exc),
                )
                continue

            if response.status_code == 429:
                wait = _retry_after_seconds(response)
                _PROVIDER_COOLDOWN_UNTIL[provider.name] = time.monotonic() + wait
                log.warning(
                    "model_rate_limited",
                    provider=provider.name,
                    op=log_event,
                    retry_after_s=round(wait),
                    body=response.text[:300],
                )
                continue

            if response.status_code >= 400:
                log.warning(
                    "model_http_error",
                    provider=provider.name,
                    op=log_event,
                    status=response.status_code,
                    body=response.text[:400],
                )
                continue

            try:
                data: dict[str, Any] = response.json()
                content = data["choices"][0]["message"]["content"]
                parsed = json.loads(content)
            except (KeyError, IndexError, json.JSONDecodeError, ValueError) as exc:
                log.warning(
                    "model_bad_response",
                    provider=provider.name,
                    op=log_event,
                    error=str(exc),
                    body=response.text[:400],
                )
                continue

            if not isinstance(parsed, dict):
                log.warning("model_non_object_json", provider=provider.name, op=log_event)
                continue

            log.info("model_completion", provider=provider.name, op=log_event)
            return parsed

        log.warning("model_all_providers_failed", op=log_event)
        return None

    async def propose_hint(
        self,
        *,
        session_id: uuid.UUID,
        recent_transcript: str,
        job_description: str,
        resume_text: str,
        mode: str = "interviewer",
    ) -> HintProposal | None:
        if not self._providers:
            log.debug("model_providers_missing", session_id=str(session_id))
            return None
        if not recent_transcript.strip():
            return None

        user_payload = (
            f"# Recent transcript window - primary evidence\n{recent_transcript.strip()[-3000:]}\n\n"
            f"# Job description - background only\n{job_description.strip()[:1200]}\n\n"
            f"# Candidate resume excerpt - background only\n{resume_text.strip()[:1200]}"
        )

        system_prompt = _CANDIDATE_HINT_SYSTEM_PROMPT if mode == "interviewee" else _SYSTEM_PROMPT
        parsed = await self._complete_json(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_payload},
            ],
            max_tokens=220,
            log_event="hint",
        )
        if parsed is None:
            return None

        kind = self._coerce_kind(parsed.get("kind"))
        text = (parsed.get("content") or "").strip()
        if not text:
            return None
        score_delta = self._coerce_float(parsed.get("score_delta"))

        log.info(
            "github_models_hint",
            session_id=str(session_id),
            kind=kind.value,
            score_delta=score_delta,
        )

        return HintProposal(
            session_id=session_id,
            kind=kind,
            content=text,
            score_delta=score_delta,
        )

    async def final_report(
        self,
        *,
        session_id: uuid.UUID,
        transcript: str,
        hints: str,
        job_description: str,
        resume_text: str,
    ) -> FinalReportProposal | None:
        if not self._providers:
            log.debug("model_providers_missing", session_id=str(session_id))
            return None
        if not transcript.strip():
            return None

        hints_block = hints.strip()
        user_payload = (
            "# Role context (NOT evidence of candidate performance)\n"
            f"## Job description\n{job_description.strip()[:2500]}\n\n"
            f"## Candidate resume / claims\n{resume_text.strip()[:2000]}\n\n"
            "# CANDIDATE TRANSCRIPT - the ONLY evidence of what the candidate actually said\n"
            f"{transcript.strip()[-8000:] or '(the candidate said nothing substantive)'}\n\n"
            "# Observed interviewer signals during the session (still not the candidate's words)\n"
            f"{hints_block[-2000:] if hints_block else '(none)'}"
        )

        parsed = await self._complete_json(
            messages=[
                {"role": "system", "content": _FINAL_REPORT_SYSTEM_PROMPT},
                {"role": "user", "content": user_payload},
            ],
            max_tokens=800,
            log_event="report",
        )
        if parsed is None:
            return None

        summary = str(parsed.get("summary") or "").strip()
        if not summary:
            return None

        proposal = FinalReportProposal(
            overall_score=self._coerce_score(parsed.get("overall_score")),
            technical_score=self._coerce_score(parsed.get("technical_score")),
            communication_score=self._coerce_score(parsed.get("communication_score")),
            culture_fit_score=self._coerce_score(parsed.get("culture_fit_score")),
            summary=summary,
            strengths=self._coerce_string_list(parsed.get("strengths")),
            weaknesses=self._coerce_string_list(parsed.get("weaknesses")),
            recommendation=self._coerce_recommendation(parsed.get("recommendation")),
        )
        log.info(
            "github_models_report",
            session_id=str(session_id),
            overall_score=proposal.overall_score,
            recommendation=proposal.recommendation.value,
        )
        return proposal

    async def answer_rubric(
        self,
        *,
        session_id: uuid.UUID,
        question: str,
        recent_transcript: str,
        job_description: str,
        resume_text: str,
    ) -> HintProposal | None:
        if not self._providers:
            log.debug("model_providers_missing", session_id=str(session_id))
            return None
        if not question.strip():
            return None

        user_payload = (
            f"# Interviewer question\n{question.strip()[:1000]}\n\n"
            f"# Recent transcript context\n{recent_transcript.strip()[-2500:]}\n\n"
            f"# Job description\n{job_description.strip()[:2000]}\n\n"
            f"# Candidate resume excerpt\n{resume_text.strip()[:1800]}"
        )

        parsed = await self._complete_json(
            messages=[
                {"role": "system", "content": _ANSWER_RUBRIC_SYSTEM_PROMPT},
                {"role": "user", "content": user_payload},
            ],
            max_tokens=600,
            log_event="rubric",
        )
        if parsed is None:
            return None

        expected = str(parsed.get("expected_answer") or "").strip()
        if not expected:
            return None

        listen_for = self._coerce_string_list(parsed.get("listen_for"))
        red_flags = self._coerce_string_list(parsed.get("red_flags"))
        follow_up = str(parsed.get("follow_up") or "").strip()
        score_guidance = str(parsed.get("score_guidance") or "").strip()

        rubric = "\n".join(
            [
                "[Rubric]",
                f"Question: {question.strip()}",
                f"Expected answer: {expected}",
                "Listen for: " + "; ".join(listen_for),
                "Red flags: " + "; ".join(red_flags),
                f"Follow-up: {follow_up}",
                f"Score guidance: {score_guidance}",
            ]
        )

        log.info("github_models_rubric", session_id=str(session_id))
        return HintProposal(
            session_id=session_id,
            kind=HintKind.CLARIFYING_PROMPT,
            content=rubric,
            score_delta=None,
        )

    async def answer_as_candidate(
        self,
        *,
        session_id: uuid.UUID,
        question: str,
        recent_transcript: str,
        job_description: str,
        resume_text: str,
    ) -> HintProposal | None:
        """Generate the actual answer the candidate should say (interviewee mode)."""
        if not self._providers:
            log.debug("model_providers_missing", session_id=str(session_id))
            return None
        if not question.strip():
            return None

        user_payload = (
            f"# Interviewer question to answer\n{question.strip()[:1000]}\n\n"
            f"# Recent transcript context\n{recent_transcript.strip()[-2500:]}\n\n"
            f"# Job description\n{job_description.strip()[:2000]}\n\n"
            f"# Candidate resume excerpt - use concrete details from here\n{resume_text.strip()[:2200]}"
        )

        parsed = await self._complete_json(
            messages=[
                {"role": "system", "content": _CANDIDATE_ANSWER_SYSTEM_PROMPT},
                {"role": "user", "content": user_payload},
            ],
            max_tokens=900,
            log_event="answer",
        )
        if parsed is None:
            return None

        answer = str(parsed.get("answer") or "").strip()
        if not answer:
            return None
        key_points = self._coerce_string_list(parsed.get("key_points"))

        lines = [
            "[Answer]",
            f"Question: {question.strip()}",
            answer,
        ]
        if key_points:
            lines.append("Key points: " + "; ".join(key_points))

        log.info("github_models_answer", session_id=str(session_id))
        return HintProposal(
            session_id=session_id,
            kind=HintKind.CLARIFYING_PROMPT,
            content="\n".join(lines),
            score_delta=None,
        )

    async def generate_question_bank(
        self,
        *,
        sections: list[str],
        job_description: str,
        resume_text: str,
        experience_level: str = "mid",
        per_section: int = 10,
    ) -> list[str]:
        """Generate a deep, sectioned interview question bank.

        Makes ONE focused LLM call per section (concurrently) so each technology
        gets its own block of `per_section` questions ramped Easy→Hard, instead
        of a single shallow call. Returns pre-formatted strings in the
        `[Difficulty] [Section] Ask: <question>` shape the dashboard renders,
        with sections concatenated in the given order (e.g. Node.js first).

        Best-effort: never raises and skips any section that fails, so it is safe
        to call inline during session creation.
        """
        if not self._providers:
            return []
        if not sections:
            return []

        level = experience_level if experience_level in ("junior", "mid", "senior") else "mid"
        # Bound concurrency so a stack with many technologies doesn't fan out into
        # an unbounded burst of inference calls at session start.
        semaphore = asyncio.Semaphore(4)

        async def run(section: str) -> tuple[str, list[tuple[str, str]]]:
            async with semaphore:
                try:
                    questions = await self._questions_for_section(
                        section=section,
                        guidance=_SECTION_GUIDANCE.get(section, ""),
                        job_description=job_description,
                        resume_text=resume_text,
                        experience_level=level,
                        count=per_section,
                    )
                except Exception as exc:  # noqa: BLE001 - one bad section must not sink the rest
                    log.warning("github_models_section_failed", section=section, error=str(exc))
                    questions = []
                return section, questions

        results = await asyncio.gather(*(run(section) for section in sections))
        by_section: dict[str, list[tuple[str, str]]] = {section: qs for section, qs in results}

        formatted: list[str] = []
        for section in sections:
            for difficulty, question in by_section.get(section, []):
                formatted.append(f"[{difficulty}] [{section}] Ask: {question}")

        log.info(
            "github_models_question_bank",
            sections=len(sections),
            total=len(formatted),
            level=level,
        )
        return formatted

    async def _questions_for_section(
        self,
        *,
        section: str,
        guidance: str,
        job_description: str,
        resume_text: str,
        experience_level: str,
        count: int,
    ) -> list[tuple[str, str]]:
        """One focused call: `count` questions for a single topic, Easy→Hard.

        Returns a list of (difficulty, question) tuples preserving the model's
        easy→hard ordering.
        """
        user_payload = (
            f"# Topic to test\n{section}\n\n"
            f"# Number of questions to produce\n{count}\n\n"
            f"# Candidate experience level\n{experience_level}\n\n"
            + (f"# Topic guidance\n{guidance}\n\n" if guidance else "")
            + f"# Job description (context only)\n{job_description.strip()[:1200]}\n\n"
            + f"# Candidate resume (context only)\n{resume_text.strip()[:1500]}"
        )

        parsed = await self._complete_json(
            messages=[
                {"role": "system", "content": _SECTION_QUESTIONS_SYSTEM_PROMPT},
                {"role": "user", "content": user_payload},
            ],
            max_tokens=1400,
            temperature=0.5,
            log_event=f"section:{section}",
        )
        if parsed is None:
            return []

        raw_questions = parsed.get("questions")
        if not isinstance(raw_questions, list):
            return []

        valid_difficulties = {"Easy", "Medium", "Hard"}
        seen: set[str] = set()
        out: list[tuple[str, str]] = []
        for item in raw_questions:
            if not isinstance(item, dict):
                continue
            difficulty = str(item.get("difficulty") or "").strip().title()
            if difficulty not in valid_difficulties:
                difficulty = "Medium"
            question = " ".join(str(item.get("question") or "").split()).strip()
            if not question:
                continue
            key = question.lower()
            if key in seen:
                continue
            seen.add(key)
            out.append((difficulty, question))

        return out

    @staticmethod
    def _coerce_kind(value: Any) -> HintKind:
        try:
            return HintKind(str(value))
        except ValueError:
            return HintKind.CLARIFYING_PROMPT

    @staticmethod
    def _coerce_float(value: Any) -> float | None:
        if value is None:
            return None
        try:
            f = float(value)
        except (TypeError, ValueError):
            return None
        return max(-10.0, min(10.0, f))

    @staticmethod
    def _coerce_score(value: Any) -> float:
        try:
            f = float(value)
        except (TypeError, ValueError):
            return 0.0
        return max(0.0, min(100.0, f))

    @staticmethod
    def _coerce_string_list(value: Any) -> list[str]:
        if not isinstance(value, list):
            return []
        return [str(item).strip() for item in value if str(item).strip()][:5]

    @staticmethod
    def _coerce_recommendation(value: Any) -> Recommendation:
        try:
            return Recommendation(str(value))
        except ValueError:
            return Recommendation.NO_HIRE
