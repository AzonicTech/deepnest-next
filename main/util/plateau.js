/**
 * Nesting search plateau detector.
 *
 * The genetic search otherwise runs until someone clicks Stop. This helper
 * decides when the best fitness (lower is better) has stopped improving.
 *
 * Either limit can fire. Zero disables that limit. Unchecking the feature
 * (enabled: false) restores run-until-Stop. The time limit cannot fire
 * before minGenerations full generations have finished (default 1).
 *
 * Works in the Electron renderer (require) and in Node unit tests.
 */
"use strict";

(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.NestPlateau = api;
  }
})(typeof window !== "undefined" ? window : typeof global !== "undefined" ? global : this, function () {
  var DEFAULTS = {
    enabled: true,
    plateauGenerations: 10, // 0 = ignore generation stall
    plateauMinutes: 1, // 0 = ignore time stall. Decimals allowed (0.5 = 30s).
    minGenerations: 1, // never auto-stop before this many completed generations
    epsilon: 1e-9, // fitness must beat best by more than this
  };

  function assign(target, source) {
    if (!source) {
      return target;
    }
    Object.keys(source).forEach(function (key) {
      if (source[key] !== undefined && source[key] !== null) {
        target[key] = source[key];
      }
    });
    return target;
  }

  // 0 is a real timestamp. Only null/undefined means "use the wall clock".
  function clock(now) {
    return now == null ? Date.now() : now;
  }

  function num(value, fallback) {
    var n = Number(value);
    if (typeof n !== "number" || !isFinite(n) || isNaN(n)) {
      return fallback;
    }
    return n;
  }

  function create(options) {
    var config = assign({}, DEFAULTS);
    assign(config, migrateSavedConfig(options || {}));
    delete config.plateauSeconds;

    var bestFitness = null;
    var generation = 0;
    var staleGenerations = 0;
    // null until the clock starts. 0 is a valid timestamp (tests), so it must
    // not be treated as "unset".
    var lastImprovementAt = null;
    var startedAt = 0;
    var stopped = null;
    var improvedThisGeneration = false;

    function snapshot(now) {
      now = clock(now);
      return {
        state: stopped ? "stopped" : generation > 0 || bestFitness !== null ? "running" : "idle",
        reason: stopped ? stopped.reason : null,
        generation: generation,
        generationsWithoutImprovement: staleGenerations,
        secondsWithoutImprovement: lastImprovementAt == null ? 0 : (now - lastImprovementAt) / 1000,
        minutesWithoutImprovement: lastImprovementAt == null ? 0 : (now - lastImprovementAt) / 60000,
        bestFitness: bestFitness,
        enabled: !!config.enabled,
        plateauGenerations: config.plateauGenerations,
        plateauMinutes: config.plateauMinutes,
      };
    }

    function evaluate(now) {
      now = clock(now);
      var current = snapshot(now);

      if (stopped) {
        return assign(current, { stop: true, reason: stopped.reason });
      }

      if (!config.enabled) {
        return assign(current, { stop: false, reason: null });
      }

      if (generation < num(config.minGenerations, 1)) {
        return assign(current, { stop: false, reason: null });
      }

      var genLimit = num(config.plateauGenerations, 0);
      var minuteLimit = num(config.plateauMinutes, 0);
      var genHit = genLimit > 0 && staleGenerations >= genLimit;
      var timeHit =
        minuteLimit > 0 &&
        lastImprovementAt != null &&
        (now - lastImprovementAt) / 60000 >= minuteLimit;

      if (genHit || timeHit) {
        var reason = "plateau";
        if (genHit && !timeHit) {
          reason = "generations";
        } else if (timeHit && !genHit) {
          reason = "time";
        }
        stopped = { reason: reason };
        current = snapshot(now);
        current.state = "stopped";
        return assign(current, { stop: true, reason: reason });
      }

      return assign(current, { stop: false, reason: null });
    }

    function considerFitness(fitness, now) {
      now = clock(now);
      var value = num(fitness, null);
      if (value === null) {
        return false;
      }
      if (bestFitness === null || value < bestFitness - config.epsilon) {
        bestFitness = value;
        staleGenerations = 0;
        lastImprovementAt = now;
        improvedThisGeneration = true;
        return true;
      }
      return false;
    }

    return {
      configure: function (next) {
        var incoming = migrateSavedConfig(next || {});
        assign(config, incoming);
        delete config.plateauSeconds;
        if (config.plateauGenerations !== undefined) {
          var gens = parseInt(config.plateauGenerations, 10);
          config.plateauGenerations = isNaN(gens) ? 0 : Math.max(0, gens);
        }
        if (config.plateauMinutes !== undefined) {
          var mins = parseFloat(config.plateauMinutes);
          config.plateauMinutes = isNaN(mins) ? 0 : Math.max(0, mins);
        }
        if (config.minGenerations !== undefined) {
          var minGens = parseInt(config.minGenerations, 10);
          config.minGenerations = isNaN(minGens) ? 0 : Math.max(0, minGens);
        }
        config.enabled = !!config.enabled;
      },

      reset: function (now) {
        now = clock(now);
        bestFitness = null;
        generation = 0;
        staleGenerations = 0;
        lastImprovementAt = now;
        startedAt = now;
        stopped = null;
        improvedThisGeneration = false;
      },

      // Keep best fitness (resume after a plateau stop) but clear stall clocks.
      resume: function (now) {
        now = clock(now);
        staleGenerations = 0;
        lastImprovementAt = now;
        stopped = null;
        improvedThisGeneration = false;
      },

      // A placement finished. Updates the time-since-improvement clock.
      onResult: function (fitness, now) {
        now = clock(now);
        considerFitness(fitness, now);
        return evaluate(now);
      },

      // A full GA generation finished. fitnesses is an array of evaluated fitness values.
      onGeneration: function (fitnesses, now) {
        now = clock(now);
        generation++;

        var genBest = null;
        if (Object.prototype.toString.call(fitnesses) === "[object Array]") {
          for (var i = 0; i < fitnesses.length; i++) {
            var value = num(fitnesses[i], null);
            if (value === null) {
              continue;
            }
            if (genBest === null || value < genBest) {
              genBest = value;
            }
          }
        } else {
          genBest = num(fitnesses, null);
        }

        if (genBest !== null) {
          considerFitness(genBest, now);
        }

        if (improvedThisGeneration) {
          staleGenerations = 0;
        } else {
          staleGenerations++;
        }
        improvedThisGeneration = false;

        // The M-second window starts after a full baseline generation,
        // not at the first partial placement (which cannot yet be a plateau).
        if (generation === 1) {
          lastImprovementAt = now;
        }

        return evaluate(now);
      },

      evaluate: evaluate,
      snapshot: snapshot,

      statusText: function (now) {
        return formatStatus(snapshot(now));
      },
    };
  }

  function formatStatus(state) {
    if (!state || state.state === "idle") {
      return "";
    }
    if (state.state === "stopped") {
      return formatStopMessage(state);
    }
    var genLabel = state.generation > 0 ? state.generation : 1;
    var parts = ["Generation " + genLabel];
    if (state.bestFitness !== null && state.bestFitness !== undefined && isFinite(state.bestFitness)) {
      parts.push("best " + formatFitness(state.bestFitness));
    }
    if (state.generationsWithoutImprovement > 0) {
      parts.push(
        "no improvement for " +
          state.generationsWithoutImprovement +
          (state.generationsWithoutImprovement === 1 ? " generation" : " generations"),
      );
    }
    var elapsedLabel = formatMinutes(
      state.minutesWithoutImprovement != null
        ? state.minutesWithoutImprovement
        : (state.secondsWithoutImprovement || 0) / 60,
    );
    if (state.generation >= 1 && elapsedLabel) {
      parts.push(elapsedLabel + " without improvement");
    }
    return parts.join(" · ");
  }

  function formatFitness(value) {
    if (Math.abs(value) >= 1000) {
      return value.toFixed(1);
    }
    return value.toFixed(4);
  }

  function formatStopMessage(state) {
    if (!state) {
      return "Nesting stopped.";
    }
    if (state.reason === "generations") {
      return (
        "Nesting stopped: no improvement for " +
        state.generationsWithoutImprovement +
        " generations. Best layout is ready to export. Click Start nest to keep searching from this result."
      );
    }
    if (state.reason === "time") {
      var waited = formatMinutes(
        state.minutesWithoutImprovement != null
          ? state.minutesWithoutImprovement
          : (state.secondsWithoutImprovement || 0) / 60,
      );
      return (
        "Nesting stopped: no improvement for " +
        (waited || "0 minutes") +
        ". Best layout is ready to export. Click Start nest to keep searching from this result."
      );
    }
    return "Nesting stopped: search plateaued. Best layout is ready to export. Click Start nest to keep searching from this result.";
  }

  function formatMinutes(minutes) {
    var value = Number(minutes);
    if (!isFinite(value) || value < 0.05) return "";
    var rounded = Math.round(value * 10) / 10;
    if (rounded < 0.1) return "";
    if (Math.abs(rounded - 1) < 0.05) return "1 minute";
    var text = Math.abs(rounded - Math.round(rounded)) < 0.001 ? String(Math.round(rounded)) : rounded.toFixed(1);
    return text + " minutes";
  }

  // Saved settings from before this field was minutes. 60 seconds becomes 1
  // minute. A file that already has plateauMinutes is left alone, so a later
  // read does not turn 1 minute into 1/60 minute.
  function migrateSavedConfig(saved) {
    if (!saved || typeof saved !== "object") return saved;
    var next = {};
    Object.keys(saved).forEach(function (key) {
      if (key !== "plateauSeconds") next[key] = saved[key];
    });
    var hasMinutes = Object.prototype.hasOwnProperty.call(saved, "plateauMinutes");
    var hasSeconds = Object.prototype.hasOwnProperty.call(saved, "plateauSeconds");
    if (!hasMinutes && hasSeconds) {
      var secs = Number(saved.plateauSeconds);
      if (typeof secs === "number" && isFinite(secs) && secs >= 0) {
        next.plateauMinutes = secs / 60;
      }
    }
    return next;
  }

  // Max-out advances the count on its own clock. A saved "0" (often a string)
  // means the operator turned that limit off, so the count still steps after
  // 10 generations or 1 minute without improvement. When a real limit is set,
  // that limit is the step trigger.
  function stepTriggerConfig(settings) {
    var src = settings || {};
    var flag = src.stopOnPlateau;
    var enabled = flag !== false && flag !== "false" && flag !== 0 && flag !== "0";
    var gens = parseFloat(src.plateauGenerations);
    var mins = parseFloat(src.plateauMinutes);
    if (!isFinite(gens) || gens < 0) gens = 0;
    if (!isFinite(mins) || mins < 0) mins = 0;
    if (!enabled || (gens <= 0 && mins <= 0)) {
      return { enabled: true, plateauGenerations: 10, plateauMinutes: 1, minGenerations: 1 };
    }
    return {
      enabled: true,
      plateauGenerations: gens,
      plateauMinutes: mins,
      minGenerations: 1,
    };
  }

  return {
    create: create,
    defaults: DEFAULTS,
    formatStatus: formatStatus,
    formatStopMessage: formatStopMessage,
    formatMinutes: formatMinutes,
    migrateSavedConfig: migrateSavedConfig,
    stepTriggerConfig: stepTriggerConfig,
  };
});
