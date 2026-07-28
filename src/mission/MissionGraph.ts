import { CAST, MISSION_V2 } from '@/config/mission';
import type { MissionStateMachine } from './MissionStateMachine';

const L = MISSION_V2.lines;
const AI = MISSION_V2.aiLines;

/**
 * The slice's transition graph, in one place.
 *
 * Read top to bottom and you have the mission. Each state declares only what
 * makes it end; the systems that satisfy those conditions (combat, the gate,
 * the boss) set flags and never touch the state directly.
 *
 * STORY RULE enforced here: no line before TRUTH_REVEAL states the AI's actual
 * intent. Several of them are true in both readings - "protected subject",
 * "safety assurance continues" - and that ambiguity is the point. If you add a
 * line, check it survives the second playthrough without becoming a lie.
 */
export function buildMissionGraph(m: MissionStateMachine): void {
  const { flags } = m.ctx;

  m.define('BOOT', {
    update: () => 'BRIEFING',
  });

  m.define('BRIEFING', {
    // Left by the player clicking through the briefing, which calls
    // request('EXTERIOR_ENTRY'). No timeout: the player reads at their pace.
  });

  m.define('EXTERIOR_ENTRY', {
    enter: (ctx) => ctx.say('open', CAST.handler, L.exteriorOpen),
    update: (ctx) => (ctx.time > 3 ? 'EXTERIOR_COMBAT' : null),
  });

  m.define('EXTERIOR_COMBAT', {
    enter: (ctx) => ctx.say('ai-intrusion', CAST.factoryAi, AI.intrusion),
    update: (ctx) => {
      // Reaching the shutter early is allowed and is how the player learns
      // WHY they need the gate unit - the lock states its own requirement.
      if (ctx.playerX > MISSION_V2.exterior.dockDiscoverX) {
        ctx.say('dock', CAST.handler, L.dockLocked);
      }
      return flags.exteriorHostilesRemaining <= MISSION_V2.exterior.clearBeforeGatekeeper
        ? 'GATEKEEPER_INTRO'
        : null;
    },
  });

  m.define('GATEKEEPER_INTRO', {
    enter: (ctx) => {
      flags.gatekeeperAlive = true;
      ctx.say('gk', CAST.handler, L.gatekeeperSpotted);
      ctx.bus.emit('mission:gatekeeperSpawn');
    },
    // Short beat only: the brief forbids long uncontrollable sequences.
    timeout: 2.5,
    onTimeout: 'GATEKEEPER_ACTIVE',
  });

  m.define('GATEKEEPER_ACTIVE', {
    update: () => (flags.gatekeeperDefeated ? 'GATEKEEPER_DEFEATED' : null),
  });

  m.define('GATEKEEPER_DEFEATED', {
    enter: (ctx) => ctx.say('mod', CAST.handler, L.moduleDropped),
    timeout: 1.2,
    onTimeout: 'ACCESS_MODULE_DROPPED',
  });

  m.define('ACCESS_MODULE_DROPPED', {
    update: () => (flags.moduleAcquired ? 'ACCESS_MODULE_ACQUIRED' : null),
  });

  m.define('ACCESS_MODULE_ACQUIRED', {
    enter: (ctx) => {
      ctx.say('modtaken', CAST.handler, L.moduleTaken);
      ctx.say('ai-restrict', CAST.factoryAi, AI.restrict);
    },
    update: () => (flags.atGateTerminal ? 'GATE_TERMINAL_ACTIVE' : null),
  });

  m.define('GATE_TERMINAL_ACTIVE', {
    // Waits for the player to actually use the terminal - the interaction sets
    // gateOpen once authentication completes.
    update: () => (flags.gateOpen ? 'GATE_OPENING' : null),
  });

  m.define('GATE_OPENING', {
    enter: (ctx) => {
      ctx.say('gate', CAST.handler, L.gateOpening);
      ctx.say('ai-approach', CAST.factoryAi, AI.approach);
      ctx.bus.emit('mission:gateOpen');
    },
    timeout: MISSION_V2.gate.openTime,
    onTimeout: 'FACTORY_ENTRY',
  });

  m.define('FACTORY_ENTRY', {
    enter: (ctx) => ctx.say('inside', CAST.handler, L.interiorEntry),
    update: () => (flags.insideFactory ? 'INTERIOR_APPROACH' : null),
  });

  m.define('INTERIOR_APPROACH', {
    enter: (ctx) => ctx.say('ai-maintain', CAST.factoryAi, AI.maintain),
    update: () => (flags.hostagesSeen ? 'HOSTAGES_DISCOVERED' : null),
  });

  m.define('HOSTAGES_DISCOVERED', {
    enter: (ctx) => {
      ctx.say('hostages', CAST.handler, L.hostagesFound);
      // The first appearance of the phrase. Never explained until the end.
      ctx.say('ai-subjects', CAST.factoryAi, AI.subjects);
    },
    update: () => (flags.reachedControlRoom ? 'BOSS_INTRO' : null),
  });

  m.define('BOSS_INTRO', {
    enter: (ctx) => {
      ctx.say('boss', CAST.handler, L.bossIntro);
      ctx.say('ai-engage', CAST.factoryAi, AI.bossEngage);
      ctx.bus.emit('mission:bossSpawn');
    },
    timeout: 4.0,
    onTimeout: 'BOSS_PHASE_1',
  });

  m.define('BOSS_PHASE_1', {
    update: () =>
      flags.bossRelaysDown >= MISSION_V2.boss.phase1Relays ? 'BOSS_PHASE_2' : null,
  });

  m.define('BOSS_PHASE_2', {
    enter: (ctx) => ctx.say('p2', CAST.handler, L.bossPhase2),
    update: () => (flags.bossCoolantDown ? 'BOSS_PHASE_3' : null),
  });

  m.define('BOSS_PHASE_3', {
    enter: (ctx) => {
      ctx.say('p3', CAST.handler, L.bossPhase3);
      ctx.bus.emit('mission:emergencyLighting', { on: true });
    },
    update: () => (flags.bossCoreDown ? 'BOSS_DEFEATED' : null),
  });

  m.define('BOSS_DEFEATED', {
    enter: (ctx) => {
      ctx.say('down', CAST.handler, L.bossDown);
      ctx.bus.emit('mission:bossDown');
    },
    // The quiet. Alarms fade, machinery spins down; then the core speaks.
    timeout: 5.5,
    onTimeout: 'TRUTH_REVEAL',
  });

  m.define('TRUTH_REVEAL', {
    enter: (ctx) => {
      ctx.bus.emit('mission:truthReveal');
    },
    // Long enough to read the log. The player keeps look control throughout.
    timeout: 22,
    onTimeout: 'HOSTAGE_RELEASE',
  });

  m.define('HOSTAGE_RELEASE', {
    enter: (ctx) => ctx.say('release', CAST.handler, L.release),
    update: () => (flags.hostagesReleased ? 'EXTRACTION' : null),
  });

  m.define('EXTRACTION', {
    enter: (ctx) => {
      ctx.say('complete', CAST.handler, L.complete);
      ctx.bus.emit('mission:extraction');
    },
    update: () => (flags.atExtraction ? 'MISSION_COMPLETE' : null),
  });

  m.define('MISSION_COMPLETE', {});
  m.define('PLAYER_DEAD', {});
  m.define('RESTARTING', {});
}
