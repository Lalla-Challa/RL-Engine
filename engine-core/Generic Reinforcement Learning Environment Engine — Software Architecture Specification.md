# Generic Reinforcement Learning Environment Engine
## Software Architecture Specification

**Version:** 1.0  
**Status:** Proposed Architecture

---

# 1. Purpose

This project is a domain-independent software engine for creating and executing **reinforcement learning environments**.

The engine must allow developers to define different environments without modifying the engine's source code.

Examples of environments include:

- Games
- Simulations
- Robotics
- Resource-management problems
- Trading simulations
- Planning problems
- Scheduling
- Logistics
- Scientific simulations
- Decision-making experiments

The same engine must be capable of running all of these environments by loading a different **Environment Specification**.

The engine itself must not contain domain-specific concepts such as:

- character
- story
- medical patient
- weapon
- stock
- vehicle
- legal case
- game character

Those concepts belong to an environment specification.

---

# 2. Core Design Principle

The system is divided into two fundamentally different layers:

```text
┌──────────────────────────────────────┐
│         ENVIRONMENT DEFINITION       │
│                                      │
│ State                                │
│ Actions                              │
│ Rules                                │
│ Transitions                          │
│ Constraints                          │
│ Observations                         │
│ Rewards                              │
│ Termination                          │
└──────────────────┬───────────────────┘
                   │
                   ▼
┌──────────────────────────────────────┐
│             ENGINE CORE              │
│                                      │
│ State Management                     │
│ Rule Evaluation                      │
│ Transition Execution                 │
│ Validation                           │
│ Observation Generation               │
│ Reward Calculation                   │
│ Randomness                            │
│ Episode Management                   │
└──────────────────┬───────────────────┘
                   │
                   ▼
┌──────────────────────────────────────┐
│             RL INTERFACE             │
│                                      │
│ reset()                              │
│ step(action)                         │
│ action_space                         │
│ observation_space                    │
└──────────────────┬───────────────────┘
                   │
                   ▼
┌──────────────────────────────────────┐
│             RL ALGORITHM             │
│                                      │
│ PPO / DQN / SAC / A2C / etc.         │
└──────────────────────────────────────┘
```

The engine is responsible for **what happens**.

The RL algorithm is responsible for **learning what to do**.

These responsibilities must remain separate.

---

# 3. Terminology

## 3.1 Environment

A complete simulated world in which an agent can perform actions.

An environment contains:

```text
State
Action Space
Transition Rules
Observation Model
Reward Function
Constraints
Termination Conditions
```

---

## 3.2 State

The complete internal condition of the environment at a particular timestep.

Example:

```json
{
  "temperature": 72,
  "battery": 84,
  "location": "warehouse_a"
}
```

The state represents the actual environment.

The agent does not necessarily have access to the complete state.

---

## 3.3 Observation

The information provided to the agent.

For a fully observable environment:

```text
Observation = State
```

For a partially observable environment:

```text
Observation ⊂ State
```

Example:

```text
Internal State:

battery = 84
enemy_location = "room_4"
enemy_health = 73
```

Agent observation:

```json
{
  "battery": 84,
  "enemy_visible": false
}
```

This distinction must be supported natively.

---

# 4. Action

An action is something the agent can request the environment to perform.

Examples:

```text
move
attack
wait
buy
sell
charge
inspect
communicate
```

Actions may contain parameters.

Example:

```json
{
  "type": "move",
  "direction": "north"
}
```

The engine must validate every action against the current environment.

An invalid action must never directly modify the environment.

---

# 5. Action Space

The environment specification defines which actions are possible.

The initial implementation should support:

### Discrete

```text
0 = left
1 = right
2 = wait
```

### Continuous

```text
steering ∈ [-1, 1]
```

### Multi-discrete

```text
movement = [direction, speed]
```

### Parameterized actions

```json
{
  "type": "move",
  "direction": "north",
  "distance": 5
}
```

### Conditional actions

An action may only become available when specified conditions are satisfied.

---

# 6. State Space

The environment specification must define its state variables.

Supported primitive types should include:

```text
boolean
integer
float
string
enum
array
object
```

Each variable may optionally define:

```text
minimum
maximum
allowed values
default value
mutable/immutable
visibility
```

Example:

```json
{
  "battery": {
    "type": "float",
    "min": 0,
    "max": 100,
    "default": 100
  }
}
```

The engine must validate state mutations against the state schema.

---

# 7. Entities

The engine may support entities as generic objects.

An entity has:

```text
id
type
attributes
state
relationships
```

The engine must not assign semantic meaning to the entity type.

For example:

```json
{
  "id": "entity_001",
  "type": "vehicle"
}
```

is valid.

But the engine must not contain special logic such as:

```text
if type == "vehicle"
```

unless that behavior is defined by the environment specification.

---

# 8. Relationships

Entities may have relationships.

Example:

```json
{
  "source": "entity_a",
  "target": "entity_b",
  "type": "owns",
  "state": {
    "strength": 0.8
  }
}
```

Relationship semantics are defined by the environment.

The core engine only understands:

```text
source
target
type
state
```

---

# 9. Environment Specification

An environment is described using a declarative specification.

Example:

```json
{
  "environment": {
    "id": "example_environment",
    "version": "1.0"
  },

  "state": {},

  "entities": [],

  "actions": [],

  "rules": [],

  "observations": [],

  "rewards": [],

  "constraints": [],

  "termination": []
}
```

The engine loads this specification and creates an executable environment.

---

# 10. Rules

Rules describe how the environment responds to conditions.

A rule contains:

```text
conditions
actions/effects
priority
probability
constraints
```

Example:

```json
{
  "id": "battery_depletion",

  "when": [
    {
      "field": "battery",
      "op": "<=",
      "value": 0
    }
  ],

  "effects": [
    {
      "target": "system",
      "field": "power_state",
      "op": "set",
      "value": "off"
    }
  ]
}
```

The engine evaluates rules against the current state.

---

# 11. Conditions

The rule system should support:

```text
==
!=
>
>=
<
<=
in
not_in
contains
exists
and
or
not
```

Conditions must be composable.

Example:

```json
{
  "all": [
    {
      "field": "battery",
      "op": "<",
      "value": 20
    },
    {
      "field": "temperature",
      "op": ">",
      "value": 80
    }
  ]
}
```

---

# 12. Effects

Rules modify state through explicit effects.

Supported operations should include:

```text
set
add
subtract
multiply
divide
append
remove
increment
decrement
create
delete
```

Example:

```json
{
  "target": "battery",
  "op": "subtract",
  "value": 10
}
```

All effects must pass state validation.

---

# 13. Transition Engine

The transition engine is responsible for:

```text
Current State
      +
Action
      +
Environment Rules
      +
Randomness
      +
Constraints
      ↓
Next State
```

Formally:

```text
Sₜ₊₁ = T(Sₜ, Aₜ, ξₜ)
```

where:

- `Sₜ` = current state
- `Aₜ` = agent action
- `T` = environment transition function
- `ξₜ` = controlled randomness

The transition engine must be deterministic when supplied with the same state, action, specification, and random seed.

The existing implementation already uses seeded randomness and avoids wall-clock/random-runtime dependencies in the simulation loop; this behavior should be retained in the generic engine.

---

# 14. Stochastic Environments

The engine must support probabilistic transitions.

Example:

```json
{
  "outcomes": [
    {
      "probability": 0.7,
      "effects": []
    },
    {
      "probability": 0.3,
      "effects": []
    }
  ]
}
```

Probabilities must be validated.

The random number generator must be centralized.

No environment rule may directly call an uncontrolled random-number source.

---

# 15. Validation Engine

Validation determines whether an action or transition is legal.

The generic validation pipeline should be:

```text
1. Schema validation
        ↓
2. Action validation
        ↓
3. Constraint validation
        ↓
4. State compatibility
        ↓
5. Transition validation
        ↓
6. Result validation
```

A failed validation produces:

```json
{
  "valid": false,
  "reason": "...",
  "layer": "state_compatibility"
}
```

The transition must not be partially applied.

---

# 16. Atomic State Transitions

A transition must be atomic.

The engine should conceptually perform:

```text
Current State
      ↓
Create temporary state
      ↓
Apply effects
      ↓
Validate temporary state
      ↓
Commit
```

If validation fails:

```text
temporary state → discarded
current state → unchanged
```

This prevents partially applied actions.

---

# 17. Observation Engine

The observation engine converts internal state into agent-visible information.

```text
Internal State
      ↓
Observation Rules
      ↓
Observation
```

Example:

```json
{
  "observations": {
    "battery": "state.battery",
    "visible_objects": {
      "source": "entities",
      "filter": "visible == true"
    }
  }
}
```

The engine must support both:

```text
fully observable environments
```

and:

```text
partially observable environments
```

---

# 18. Reward Engine

Reward is a first-class component.

The environment defines:

```text
R(Sₜ, Aₜ, Sₜ₊₁)
```

Example:

```json
{
  "reward": {
    "expression": "new_score - old_score"
  }
}
```

The engine returns the reward after each action.

Example result:

```json
{
  "observation": {},
  "reward": 1.5,
  "terminated": false,
  "truncated": false,
  "info": {}
}
```

The reward system must support:

```text
positive rewards
negative rewards
zero rewards
multiple reward components
reward shaping
terminal rewards
penalties
```

---

# 19. Reward Composition

Rewards should optionally be composed from multiple components.

Example:

```json
{
  "rewards": [
    {
      "id": "goal_progress",
      "expression": "progress_delta",
      "weight": 1.0
    },
    {
      "id": "energy_cost",
      "expression": "-energy_used",
      "weight": 0.2
    }
  ]
}
```

Final reward:

```text
R = Σ(component × weight)
```

The engine should expose both:

```text
final reward
```

and, optionally:

```text
reward components
```

for debugging and analysis.

---

# 20. Episode Manager

An episode represents one complete interaction between an agent and an environment.

Lifecycle:

```text
CREATE
  ↓
RESET
  ↓
STEP
  ↓
STEP
  ↓
STEP
  ↓
TERMINATED
```

The environment must support:

```text
reset()
step(action)
```

---

# 21. RL Environment API

The minimum environment interface should be:

```typescript
interface Environment {
    reset(seed?: number | string): ResetResult;

    step(action: Action): StepResult;

    getActionSpace(): ActionSpace;

    getObservationSpace(): ObservationSpace;

    getState(): State;

    getSpecification(): EnvironmentSpecification;
}
```

`StepResult`:

```typescript
interface StepResult {
    observation: Observation;
    reward: number;
    terminated: boolean;
    truncated: boolean;
    info: Record<string, unknown>;
}
```

---

# 22. Reset

`reset()` creates the initial state of an episode.

```text
reset(seed)
     ↓
Initial State
     ↓
Initial Observation
```

Reset must not modify the environment specification.

It must create a new episode state.

---

# 23. Step

`step(action)` performs exactly one environment transition.

```text
step(action)
     │
     ├── validate action
     │
     ├── evaluate rules
     │
     ├── calculate transition
     │
     ├── apply effects
     │
     ├── validate resulting state
     │
     ├── calculate reward
     │
     ├── generate observation
     │
     ├── check termination
     │
     └── return StepResult
```

A single call to `step()` must represent one logical environment timestep.

---

# 24. Event System

The engine should optionally record events generated during transitions.

An event contains:

```text
id
timestamp/timestep
source
action
effects
state changes
causes
metadata
```

Events are useful for:

- debugging
- replay
- training analysis
- visualization
- causal analysis
- environment auditing

Events must not be required for basic RL operation.

The event system should therefore be an optional engine subsystem.

---

# 25. Causal Tracking

The engine may maintain relationships between events.

Example:

```text
Action A
   ↓
State Change B
   ↓
Event C
   ↓
Reward D
```

This allows a trajectory to be represented as more than a sequence of numbers.

However, causal tracking must remain generic.

The engine must not contain domain-specific causal assumptions.

---

# 26. Trajectory Recorder

The RL layer should record:

```text
observation
action
reward
next observation
termination
environment state
optional event information
```

A trajectory:

```text
τ = (s₀, a₀, r₁, s₁, a₁, r₂, s₂, ...)
```

The recorder must support:

```text
in-memory trajectories
streaming trajectories
persistent trajectories
episode replay
export
```

---

# 27. Replay System

The engine should support replaying an episode using:

```text
environment specification
initial state
random seed
action sequence
```

The replay should reproduce the same environment trajectory when the environment is deterministic under the supplied seed.

This is essential for:

- debugging
- regression testing
- reproducibility
- RL experiments

---

# 28. Randomness Architecture

All stochastic behavior must pass through one controlled random-number service.

```text
RandomService
     │
     ├── rule probabilities
     ├── stochastic transitions
     ├── environment events
     └── tie-breaking
```

The service must support:

```text
seed
nextFloat()
nextInt()
choice()
weightedChoice()
```

The environment must never directly use:

```text
Math.random()
```

or equivalent uncontrolled randomness.

---

# 29. Persistence

Persistence must remain outside the simulation kernel.

Architecture:

```text
Storage
   ↓
Environment Loader
   ↓
Environment Object
   ↓
Simulation Engine
   ↓
Run Result
   ↓
Persistence Adapter
```

The core engine must not require:

- SQL
- filesystem
- HTTP
- database connections
- web frameworks

The existing architecture already follows this principle: simulation receives a world and returns a result, while loading and persistence happen outside the simulation loop.

---

# 30. Domain Plugins

Domain-specific functionality must be implemented through plugins or specifications.

Example:

```text
engine/
│
├── core/
│
├── environment/
│
├── rules/
│
├── validation/
│
├── observation/
│
├── reward/
│
├── episode/
│
└── plugins/
```

A plugin may provide:

```text
custom state types
custom actions
custom validators
custom transition functions
custom reward functions
custom observation functions
```

Plugins must use a defined interface.

The core engine must not import individual domain plugins.

---

# 31. Custom Functions

The specification system should support a controlled function registry.

Example:

```json
{
  "function": "distance_between",
  "arguments": [
    "agent.position",
    "target.position"
  ]
}
```

The function registry might contain:

```text
distance_between
clamp
min
max
abs
random
count
sum
average
```

Custom domain functions can be registered through the plugin interface.

Arbitrary source-code execution from an environment specification must not be allowed by default.

---

# 32. Environment Compiler

A major component should be an **Environment Compiler**.

Its responsibility:

```text
Environment Specification
        ↓
Schema Validation
        ↓
Reference Resolution
        ↓
Rule Compilation
        ↓
Action Compilation
        ↓
Reward Compilation
        ↓
Observation Compilation
        ↓
Executable Environment
```

The compiler should detect errors before training begins.

Examples:

```text
undefined state variable
invalid action
invalid rule operator
impossible probability
invalid reward expression
invalid state mutation
circular dependency
unknown function
```

---

# 33. Environment Validation

Before an environment can be used for training:

```text
Environment Specification
        ↓
Static Validation
        ↓
Environment Test
        ↓
Ready
```

The system should automatically test:

### State validity

Can the initial state exist?

### Action validity

Does every declared action have a valid definition?

### Transition validity

Can rules produce illegal states?

### Reward validity

Can reward calculation produce invalid values?

### Observation validity

Does every observation reference a valid source?

### Termination validity

Can episodes terminate correctly?

---

# 34. Training Layer

The RL training system is separate from the environment engine.

Architecture:

```text
              ┌───────────────────┐
              │   Environment     │
              └─────────┬─────────┘
                        │
                   observations
                        │
                        ▼
              ┌───────────────────┐
              │      Policy       │
              └─────────┬─────────┘
                        │
                     action
                        │
                        ▼
              ┌───────────────────┐
              │   Environment     │
              └─────────┬─────────┘
                        │
                 reward + state
                        │
                        ▼
              ┌───────────────────┐
              │     Trainer      │
              └───────────────────┘
```

The environment must not know which RL algorithm is being used.

---

# 35. RL Algorithm Interface

The training layer should expose an abstract policy interface:

```typescript
interface Policy {
    act(observation: Observation): Action;

    update(batch: TrainingBatch): void;

    save(path: string): void;

    load(path: string): void;
}
```

Algorithms such as:

```text
PPO
DQN
SAC
A2C
REINFORCE
```

should be implementations of this interface rather than being embedded into the environment.

---

# 36. Human Feedback

Human feedback is an optional training signal.

The system should support:

### Scalar feedback

```text
+1
-1
0
```

### Preference feedback

```text
Trajectory A > Trajectory B
```

### Ranking

```text
A > C > B > D
```

### Critique

```text
Trajectory B violated constraint X.
```

Human feedback must be stored separately from the environment definition.

---

# 37. Preference Learning

Preference data may be converted into training data.

Example:

```text
Trajectory A
Trajectory B

Human preference:
A preferred over B
```

The RL layer may use this information to train:

```text
reward models
policies
value functions
preference models
```

The environment itself remains unchanged.

---

# 38. Reward vs Human Feedback

The architecture must distinguish:

```text
Environment Reward
```

from:

```text
Human Feedback
```

Environment reward answers:

> How successful was the agent according to the environment?

Human feedback answers:

> Which behavior does a human prefer?

They may eventually be combined, but they are different signals.

---

# 39. LLM Integration

An LLM must be optional.

The core system must function without:

```text
LLM
VLM
external AI API
cloud service
```

An LLM may optionally act as:

```text
Environment Specification Generator
Environment Specification Editor
Reward Designer
Feedback Interpreter
Training Assistant
Policy
```

Example:

```text
Human Description
      ↓
Optional LLM
      ↓
Environment Specification
      ↓
Environment Compiler
      ↓
CCE Runtime
```

The LLM must never bypass environment validation.

---

# 40. Security Boundary

Environment specifications are executable logic in a declarative form.

Therefore:

```text
Environment Specification
          ↓
Compiler
          ↓
Sandboxed Runtime
```

The specification must not have unrestricted access to:

```text
filesystem
network
operating system
process execution
environment variables
credentials
```

unless explicitly authorized by a trusted plugin.

---

# 41. Project Structure

Recommended implementation structure:

```text
rl-engine/
│
├── core/
│   ├── state/
│   ├── actions/
│   ├── rules/
│   ├── transitions/
│   ├── validation/
│   ├── randomness/
│   └── entities/
│
├── environment/
│   ├── environment.ts
│   ├── specification.ts
│   ├── compiler.ts
│   ├── loader.ts
│   └── validator.ts
│
├── observation/
│   ├── observation.ts
│   └── observationCompiler.ts
│
├── reward/
│   ├── reward.ts
│   └── rewardCompiler.ts
│
├── episode/
│   ├── episode.ts
│   ├── trajectory.ts
│   └── replay.ts
│
├── events/
│   ├── event.ts
│   └── causalGraph.ts
│
├── plugins/
│   ├── plugin.ts
│   └── registry.ts
│
├── persistence/
│   ├── loader.ts
│   └── persister.ts
│
├── rl/
│   ├── policy.ts
│   ├── trainer.ts
│   ├── rollout.ts
│   ├── replayBuffer.ts
│   └── feedback.ts
│
├── testing/
│   ├── environmentTests.ts
│   ├── determinism.ts
│   └── propertyTests.ts
│
└── api/
    └── environmentApi.ts
```

---

# 42. Separation of Responsibilities

The following boundaries are mandatory.

| Component | Responsibility |
|---|---|
| State Engine | Store and modify state |
| Rule Engine | Determine applicable rules |
| Transition Engine | Produce next state |
| Validation Engine | Determine legality |
| Observation Engine | Produce agent observation |
| Reward Engine | Calculate reward |
| Episode Manager | Manage episodes |
| Event System | Record environment events |
| Random Service | Control stochastic behavior |
| Environment Compiler | Convert specification into executable environment |
| Persistence | Save/load environments and trajectories |
| RL Trainer | Train policies |
| Policy | Select actions |
| Human Feedback | Provide external preference signals |
| LLM Adapter | Optional AI assistance |

No component should silently assume another component's responsibilities.

---

# 43. Core Runtime

The complete runtime should conceptually execute:

```text
                 RESET
                   │
                   ▼
             Initial State
                   │
                   ▼
             Observation
                   │
                   ▼
              ┌─────────┐
              │ POLICY  │
              └────┬────┘
                   │
                 ACTION
                   │
                   ▼
             Action Validator
                   │
                   ▼
              Rule Engine
                   │
                   ▼
          Transition Calculation
                   │
                   ▼
            State Validation
                   │
                   ▼
             Commit State
                   │
          ┌────────┼────────┐
          ▼        ▼        ▼
       Reward   Events   Observation
          │        │        │
          └────────┴────────┘
                   │
                   ▼
             Termination?
              /          \
            No            Yes
            │              │
            └──── STEP ────┘
```

---

# 44. Determinism Requirements

The engine must support reproducible experiments.

Given:

```text
Environment Specification
Initial State
Environment Seed
Action Sequence
```

the resulting trajectory must be reproducible.

This is particularly important for:

- debugging
- benchmarking
- regression testing
- scientific experiments
- comparing algorithms

The existing implementation's seeded deterministic simulation behavior should therefore become a formal requirement of the generic engine rather than remaining an implementation detail.

---

# 45. Testing Architecture

The engine should have several levels of testing.

## Unit Tests

Test:

```text
conditions
effects
state operations
rules
rewards
observations
randomness
validation
```

## Environment Tests

Test:

```text
reset
step
action legality
state transitions
reward correctness
termination
```

## Determinism Tests

Run:

```text
same environment
same seed
same actions
```

and verify identical trajectories.

## Property Tests

Verify properties such as:

```text
battery never < 0
probabilities always sum correctly
invalid actions never mutate state
terminated episodes cannot continue
```

## Training Tests

Verify that the RL layer can:

```text
create rollouts
store trajectories
update policies
save checkpoints
restore checkpoints
```

---

# 46. Migration Strategy

The existing domain-specific engine should not be rewritten from scratch.

The migration should occur in stages.

## Phase 1 — Extract Generic Primitives

Extract:

```text
State
Entity
Action
Condition
Effect
Rule
Transition
Constraint
Observation
Reward
Episode
Event
Randomness
Validation
```

Remove domain-specific naming from these primitives.

---

## Phase 2 — Generalize the Rule DSL

The current JSON rule system already provides a foundation through conditions, candidate events, effects, state changes, probabilities, and scopes.

Convert it into a generic rule system:

```text
Condition
→
Rule
→
Transition
→
Effect
```

rather than:

```text
Condition
→
Candidate Story Event
→
Narrative Weight
→
Story Event
```

---

## Phase 3 — Extract Domain Logic

Move all domain-specific concepts out of the engine.

Examples:

```text
goals
drives
habits
narrative constraints
narrative weight
story episodes
scene skeletons
```

These should become fields or modules defined by a domain specification.

The current implementation contains domain-specific pressure calculations and narrative constraint logic; these should become optional domain modules rather than core engine behavior.

---

## Phase 4 — Introduce Action Space

Add:

```text
ActionDefinition
ActionSpace
ActionValidator
```

and make:

```text
step(action)
```

the primary environment interface.

---

## Phase 5 — Introduce Observation Space

Separate:

```text
internal state
```

from:

```text
agent observation
```

The existing observation/knowledge mechanism provides useful infrastructure for this separation, but its current domain-specific semantics must be generalized.

---

## Phase 6 — Introduce Reward Engine

Create a dedicated:

```text
RewardDefinition
RewardEvaluator
RewardComponent
```

system.

Reward must not be embedded inside arbitrary transition code.

---

## Phase 7 — Introduce Episode and Trajectory APIs

Implement:

```text
reset()
step()
trajectory recording
replay
```

---

## Phase 8 — Introduce RL Training Layer

Only after the environment API is stable should the project add:

```text
rollouts
policies
trainers
replay buffers
RL algorithms
```

This prevents the environment engine from becoming coupled to a particular learning algorithm.

---

## Phase 9 — Convert the Original Domain into a Domain Pack

The original domain becomes one environment/domain specification.

It should run on the generic engine without modifying the engine core.

This becomes the primary proof that the architecture is genuinely domain-independent.

---

# 47. Final Target

The finished system should allow a developer to create a new environment by providing:

```text
Environment Specification
+
Optional Plugin
```

rather than modifying the engine source.

The intended workflow is:

```text
Developer
   │
   ▼
Environment Specification
   │
   ▼
Environment Compiler
   │
   ▼
Generic RL Environment
   │
   ├──────────────┐
   ▼              ▼
Policy          Human Feedback
   │              │
   ▼              ▼
Action          Preference
   │              │
   └──────┬───────┘
          ▼
       Training
          │
          ▼
     Learned Policy
```

The core principle is:

> **The environment defines the world, rules, consequences, observations, and rewards. The RL system learns how to act within that environment.**

The engine should not know what the environment represents.

That is what makes it a **general-purpose reinforcement learning tool rather than a domain-specific simulator with an RL interface.**