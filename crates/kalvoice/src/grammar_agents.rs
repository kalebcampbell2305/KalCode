//! Coding agents by status (owner directive 2026-10-04: agent status is provider-agnostic).
//!
//! "Show me all agents that need me", "which agents need me", "how many agents are working",
//! "open the agent that just finished", "close all idle agents". Every status word maps to the
//! shared [`AgentFilter`] (`crates/contracts/src/agent_state.rs`): the same groups the Agents tab
//! shows, for Claude Code, Codex, Cursor, Gemini CLI and every future provider alike. A named
//! provider ("show my Codex agents that need me") only narrows the agents; the status stays the
//! shared one, and nothing here depends on which provider an agent runs.
//!
//! These rules run before the session-by-state rules, so only plural lists ("the failed
//! agents") filter the Agents tab; a single one ("show me the failed thread") still focuses it.

use kalcode_contracts::agent::ProviderId;
use kalcode_contracts::agent_state::AgentFilter;
use kalcode_contracts::kalvoice::KalVoiceIntent;

use super::{Build, Caps, Understood};

/// What the Agents tab lists, as people say it. Plural only (see the module comment).
const LISTED: &str = "(agents|coding agents|threads|sessions|tasks|work)";
/// Coding agents, for questions about them ("which agents need me").
const AGENT: &str = "(agents|agent|coding agents|coding agent)";
/// "All", "all of my", "the", "my".
const DET: &str = "[all|all the|all of the|all my|all of my|every|the|my]";
/// "Show", as an Agents-tab filter verb.
const SHOW: &str = "(show|display|list|filter|give) [me] [only|just]";
const ONLY_SHOW: &str = "only (show|display|list) [me]";
/// Opening one agent.
const OPEN: &str =
    "(open|focus|focus on|show|show me|go to|take me to|switch to|jump to|bring up|pull up)";
/// Closing idle agents: KalTidy's idle-agent close, never a stop of everything.
const CLOSE: &str =
    "(close|stop|kill|end|terminate|shut down|clear|clean up|clear out|tidy up|tidy)";

/// The statuses a filter phrase can name, in the order they're tried.
const FILTERS: [AgentFilter; 6] = [
    AgentFilter::NeedsYou,
    AgentFilter::Working,
    AgentFilter::Waiting,
    AgentFilter::Idle,
    AgentFilter::Done,
    AgentFilter::Failed,
];

/// The words naming `filter` before the noun ("working agents").
fn before(filter: AgentFilter) -> Option<&'static str> {
    Some(match filter {
        AgentFilter::Working => "(working|running|active|busy)",
        AgentFilter::Waiting => "(waiting|blocked)",
        AgentFilter::Idle => "idle",
        AgentFilter::Done => "(completed|finished|done)",
        AgentFilter::Failed => "(failed|failing|errored|crashed|broken)",
        AgentFilter::NeedsYou | AgentFilter::All => return None,
    })
}

/// "… that need me": the person, never "waiting" alone (that is the Waiting group).
const NEEDS_ME: &str =
    "(me|you|my attention|attention|my input|input|an answer|my answer|a reply|my reply)";

/// The words naming `filter` after the noun ("agents that are working").
fn after(filter: AgentFilter) -> &'static [&'static str] {
    match filter {
        AgentFilter::NeedsYou => &[
            "[that|which|who] (need|needs|needing) (me|you|my attention|attention|my input|input|an answer|my answer|a reply|my reply)",
            "[that are|which are|that is|which is] [currently|still] waiting (for|on) (me|you|my input|my answer|an answer|input|a reply|my reply)",
        ],
        AgentFilter::Working => &[
            "[that are|which are|that is|which is|currently] [currently|still] (working|running|busy)",
        ],
        AgentFilter::Waiting => {
            &["[that are|which are|that is|which is|currently] [currently|still] (waiting|blocked)"]
        }
        AgentFilter::Idle => {
            &["[that are|which are|that is|which is|currently] [currently|still] idle"]
        }
        AgentFilter::Done => &[
            "[that are|which are|that have|which have|that|which|that is] [already] (completed|finished|done)",
        ],
        AgentFilter::Failed => &[
            "[that have|which have|that|which|that are|which are] (failed|errored|crashed|broken)",
        ],
        AgentFilter::All => &[],
    }
}

/// The predicate of a question about agents ("which agents *are working*").
fn asked(filter: AgentFilter) -> &'static [&'static str] {
    match filter {
        AgentFilter::NeedsYou => &[
            "(need|needs|want|wants) (me|you|my attention|attention|my input|input|an answer|my answer|a reply|my reply)",
            "(are|is) [currently|still] waiting (for|on) (me|you|my input|my answer|an answer|input|a reply|my reply)",
        ],
        AgentFilter::Working => &["(are|is) [currently|still] (working|running|busy|active)"],
        AgentFilter::Waiting => &["(are|is) [currently|still] (waiting|blocked)"],
        AgentFilter::Idle => &["(are|is) [currently|still] idle"],
        AgentFilter::Done => &[
            "(are|is) [already] (done|finished|complete|completed)",
            "(have|has) [already] (finished|completed)",
            "[just] (finished|completed)",
        ],
        AgentFilter::Failed => &[
            "(failed|crashed|errored)",
            "(have|has) (failed|crashed|errored)",
            "(are|is) (failed|broken)",
        ],
        AgentFilter::All => &[],
    }
}

fn provider(c: &Caps) -> Option<ProviderId> {
    c.provider.map(ProviderId::new)
}

fn filter_agents(filter: AgentFilter) -> Build {
    Box::new(move |c: &Caps| {
        Understood::intent(KalVoiceIntent::FilterAgents {
            filter,
            provider_id: provider(c),
        })
    })
}

fn which_agents(filter: AgentFilter) -> Build {
    Box::new(move |c: &Caps| {
        Understood::intent(KalVoiceIntent::WhichAgents {
            filter,
            provider_id: provider(c),
        })
    })
}

fn count_agents(filter: AgentFilter) -> Build {
    Box::new(move |c: &Caps| {
        Understood::intent(KalVoiceIntent::CountAgents {
            filter,
            provider_id: provider(c),
        })
    })
}

/// Agent rules tried before the session-by-state rules.
pub(super) fn agent_rules(add: &mut impl FnMut(String, Build)) {
    // "Open the agent that just finished": the newest finished coding agent, of any provider
    // unless one is named. Before the filters, whose plural "agents that finished" lists them.
    let finished = || -> Build {
        Box::new(|c: &Caps| {
            Understood::intent(KalVoiceIntent::OpenFinishedAgent {
                provider_id: provider(c),
            })
        })
    };
    const ONE: &str = "(agent|coding agent|one|terminal|session)";
    const FINISHED: &str = "(finished|completed|got done|is done|was done|finished up)";
    add(
        format!(
            "{OPEN} [me] [the|my] [<provider>] {ONE} [that|which|who] [just|recently] {FINISHED} [last|just|most recently]"
        ),
        finished(),
    );
    add(
        format!(
            "{OPEN} [me] [the|my] (last|latest|most recent|newest|recently) (finished|completed) [<provider>] {ONE}"
        ),
        finished(),
    );

    // "Close all idle agents": KalTidy's idle-agent close, never a stop of every session.
    let close_idle = || -> Build {
        Box::new(|c: &Caps| {
            Understood::intent(KalVoiceIntent::CloseIdleAgents {
                provider_id: provider(c),
            })
        })
    };
    const IDLE_AGENTS: &str = "(agents|agent|coding agents|sessions)";
    add(
        format!("{CLOSE} {DET} [<provider>] idle [<provider>] {IDLE_AGENTS}"),
        close_idle(),
    );
    add(
        format!(
            "{CLOSE} {DET} [<provider>] {IDLE_AGENTS} (that are|which are|that is|which is) [currently|still] idle"
        ),
        close_idle(),
    );
    // Idle terminals are KalTidy's terminal tidy, which runs in KalCode's window (it reads each
    // terminal's screen and processes). Natively they are refused: never "stop everything".
    add(
        format!("{CLOSE} {DET} idle (terminals|terminal|shells)"),
        Box::new(|_: &Caps| Understood::Rejected {
            code: "kaltidy_in_window",
            message: "KalTidy closes idle terminals from KalCode's window. Nothing was stopped."
                .into(),
        }),
    );

    // "Which agents need me?" / "which Codex agent failed?"
    for filter in FILTERS {
        for predicate in asked(filter) {
            add(
                format!("(which|what) [of] [the|my] [<provider>] {AGENT} {predicate}"),
                which_agents(filter),
            );
            add(
                format!("how many [of] [the|my] [<provider>] {AGENT} {predicate}"),
                count_agents(filter),
            );
        }
        if let Some(words) = before(filter) {
            add(
                format!(
                    "how many {words} [<provider>] {AGENT} [are there|do i have|have i got|are open]"
                ),
                count_agents(filter),
            );
        }
    }
    add(
        format!(
            "how many [<provider>] {AGENT} [are there|do i have|have i got|are open|are in the fleet]"
        ),
        count_agents(AgentFilter::All),
    );

    // "Show me all agents that need me" / "show (me) (all) (the) failed agents" / "show my
    // Codex agents that need me".
    for filter in FILTERS {
        if let Some(words) = before(filter) {
            for verb in [SHOW, ONLY_SHOW] {
                add(
                    format!("{verb} {DET} [<provider>] {words} [<provider>] {LISTED}"),
                    filter_agents(filter),
                );
            }
        }
        for words in after(filter) {
            for verb in [SHOW, ONLY_SHOW] {
                add(
                    format!("{verb} {DET} [<provider>] {LISTED} {words}"),
                    filter_agents(filter),
                );
            }
        }
    }
    add(
        format!(
            "(show|display|list) [me] (all|every|all the|all of the|all my|all of my) [<provider>] {LISTED}"
        ),
        filter_agents(AgentFilter::All),
    );
    // "Show Cursor agents": a provider alone, every status.
    add(
        "(show|display|list) [me] [the|my] <provider> (agents|coding agents)".into(),
        filter_agents(AgentFilter::All),
    );
}

/// Filter phrases without an agent noun ("show everything waiting for me"). Tried late, after
/// the approvals panel's own phrases, exactly where the Dashboard filters always were.
pub(super) fn late_filter_rules(add: &mut impl FnMut(String, Build)) {
    // "for me" is trailing filler, so "… waiting for me" arrives as "… waiting".
    add(
        format!(
            "{SHOW} (everything|all|anything|all the things|whatever is|what) [that is|that are] (waiting [for|on] [me]|(that needs|that need|needing) {NEEDS_ME})"
        ),
        filter_agents(AgentFilter::NeedsYou),
    );
    add(
        format!("{ONLY_SHOW} (everything|what) [that is|that are] waiting [for|on] [me]"),
        filter_agents(AgentFilter::NeedsYou),
    );
    add(
        format!("{SHOW} [me] what (is|has) (completed|finished|done)"),
        filter_agents(AgentFilter::Done),
    );
    add(
        format!("{SHOW} [me] what (has|have) failed"),
        filter_agents(AgentFilter::Failed),
    );
    add(
        "(show|display|list) [me] everything on the dashboard".into(),
        filter_agents(AgentFilter::All),
    );
    add(
        "(clear|reset|remove) [the|my] [dashboard|agent|agents] (filter|filters)".into(),
        filter_agents(AgentFilter::All),
    );
}
