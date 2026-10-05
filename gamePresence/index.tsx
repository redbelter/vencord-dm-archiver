/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 redbelter
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// GamePresence — spoof your OWN activity: "Playing <anything>", with rich
// lines, a fake elapsed timer, up to two profile buttons and a player-count
// chip. Everything is local: one FluxDispatcher event tells Discord what to
// broadcast as your presence; nothing here touches anyone else's client.
//
// Same LOCAL_ACTIVITY_UPDATE mechanism Vencord's own musicRichPresence uses
// (socketId keeps them from fighting over the slot).

import { ApplicationCommandOptionType, findOption } from "@api/Commands";
import { definePluginSettings, SettingsStore } from "@api/Settings";
import { getUserSettingLazy } from "@api/UserSettings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { FluxDispatcher, showToast } from "@webpack/common";

import { buildActivity, parseParty } from "./engine";

const log = new Logger("GamePresence");

// Discord hides ALL activities when the user has "Display current activity as
// a status message" off (Settings -> Activity Privacy). Upstream customRPC
// force-enables this too — without it, every spoof is silently invisible.
const ShowCurrentGame = getUserSettingLazy<boolean>("status", "showCurrentGame")!;

// Activities need an application_id in the payload (a missing one is silently
// dropped by the client), but a plain spoof doesn't need a REAL app: "0" is
// what upstream Vencord's customRPC ships as its fallback and it broadcasts +
// renders fine. (Artwork only resolves from a registered app's assets — a
// plain name shows its own icon; that's Discord's, not ours.)
const APP_ID = "0";
const SOCKET_ID = "GamePresence";

const settings = definePluginSettings({
    // NOTE: deliberately NOT "enabled" — the framework itself stores the
    // plugin on/off flag at plugins.GamePresence.enabled; a setting of the
    // same name would fight the plugin enable toggle.
    active: {
        type: OptionType.BOOLEAN,
        description: "Broadcast the fake activity below (turn off to vanish it instantly).",
        default: false,
    },
    neverShow: {
        type: OptionType.BOOLEAN,
        description: "Hard privacy mode: NEVER show any activity. This plugin's spoof stays hidden AND Discord's activity display is pinned OFF, so auto-detected games (VALORANT etc.) stay invisible to everyone too. Re-applied every launch.",
        default: false,
    },
    name: {
        type: OptionType.STRING,
        description: "The activity title — shown after Playing/Watching/etc. (no effect while neverShow is on).",
        placeholder: "Cyberpunk 2077",
        default: "",
    },
    verb: {
        type: OptionType.STRING,
        description: "playing · streaming · listening · watching · competing",
        default: "playing",
    },
    details: {
        type: OptionType.STRING,
        description: "Rich-presence line 1 (optional) — e.g. a mission or channel name.",
        default: "",
    },
    state: {
        type: OptionType.STRING,
        description: "Rich-presence line 2 (optional) — e.g. a map or lobby.",
        default: "",
    },
    hours: {
        type: OptionType.NUMBER,
        description: "Fake elapsed head-start in hours for the 'HH:MM elapsed' timer (0 = fresh).",
        default: 0,
    },
    button1Label: { type: OptionType.STRING, description: "Profile button 1 label (needs a url).", default: "" },
    button1Url: { type: OptionType.STRING, description: "Profile button 1 url (https).", default: "" },
    button2Label: { type: OptionType.STRING, description: "Profile button 2 label (needs a url).", default: "" },
    button2Url: { type: OptionType.STRING, description: "Profile button 2 url (https).", default: "" },
    party: {
        type: OptionType.STRING,
        description: "Player-count chip, '2 / 5' style (blank = none).",
        default: "",
    },
});

// debounce: one presence dispatch per burst of settings writes, not one per keystroke field
let pending = false;
function onSettingsChanged() {
    if (pending) return;
    pending = true;
    setTimeout(() => {
        pending = false;
        apply("settings");
    }, 100);
}

function currentActivity(): Record<string, any> | null {
    return buildActivity({ ...settings.store, enabled: settings.store.active } as any, Date.now(), APP_ID);
}

// remembers that WE flipped Discord's activity display false->true this
// session, so stop() can undo it — leaving no trace when the user turns us off
let gateForcedByUs = false;

function apply(reason: string) {
    if (settings.store.neverShow) {
        // Hard privacy mode: refuse to broadcast AND pin Discord's activity
        // display off — hides auto-detected games (VALORANT etc.) from
        // everyone, including anything other plugins would show.
        FluxDispatcher.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", activity: null, socketId: SOCKET_ID });
        try {
            if (ShowCurrentGame.getSetting() !== false) ShowCurrentGame.updateSetting(false);
        } catch (e) {
            log.warn("could not pin showCurrentGame=false:", e);
        }
        gateForcedByUs = false; // we now own the OFF state, not the ON one
        log.debug(`presence suppressed — neverShow (${reason})`);
        return;
    }
    const activity = currentActivity();
    if (activity) {
        // if Discord's activity display is off, nothing we dispatch will ever
        // be seen (not even by us) — flip it on, same as upstream customRPC
        try {
            if (!ShowCurrentGame.getSetting()) {
                ShowCurrentGame.updateSetting(true);
                gateForcedByUs = true;
                log.info("force-enabled Activity Privacy 'showCurrentGame' (activities were hidden)");
            }
        } catch (e) {
            log.warn("could not ensure showCurrentGame:", e);
        }
    } else if (gateForcedByUs) {
        // our spoof just went away (active off / clear / empty). The gate was
        // only ever on FOR the spoof — flip it back, otherwise turning this
        // plugin "off" would START broadcasting auto-detected real games.
        try {
            if (ShowCurrentGame.getSetting() === true) ShowCurrentGame.updateSetting(false);
        } catch (e) {
            log.warn("could not restore showCurrentGame:", e);
        }
        gateForcedByUs = false;
    }
    FluxDispatcher.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", activity, socketId: SOCKET_ID });
    log.debug(`presence ${activity ? "updated" : "cleared"} (${reason}) — ${activity?.name ?? "-"}`);
}

function cfgFrom(args: any[]) {
    const s = settings.store;
    const name = (findOption(args, "name") as string | undefined)?.trim();
    return {
        enabled: true,
        name: name || s.name,
        verb: (findOption(args, "verb") as string | undefined)?.trim() || s.verb || "playing",
        details: (findOption(args, "details") as string | undefined) ?? s.details,
        state: (findOption(args, "state") as string | undefined) ?? s.state,
        hours: Number(findOption(args, "hours")) >= 0 ? Number(findOption(args, "hours")) : (s.hours || 0),
        button1Label: s.button1Label, button1Url: s.button1Url,
        button2Label: s.button2Label, button2Url: s.button2Url,
        party: parseParty((findOption(args, "party") as string | undefined) ?? s.party),
    };
}

export default definePlugin({
    name: "GamePresence",
    description: "Spoof your own activity — \"Playing anything\", rich lines, fake elapsed timer, profile buttons.",
    authors: [{ name: "redbelter", id: 0n /* replace with your Discord snowflake */ }],
    dependencies: ["UserSettingsAPI"],
    settings,

    start() {
        // re-apply on every launch so your status is effectively permanent
        apply("start");
        // live-apply whenever any GamePresence setting changes (Settings page
        // or /playing write-through both land here)
        SettingsStore.addPrefixChangeListener("plugins.GamePresence", onSettingsChanged);
    },

    stop() {
        SettingsStore.removePrefixChangeListener("plugins.GamePresence", onSettingsChanged);
        FluxDispatcher.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", activity: null, socketId: SOCKET_ID });
        // Leave no trace: if we forced Discord's activity display on this
        // session (or hard privacy is on), flip it back off — otherwise
        // auto-detected games would START broadcasting the moment this
        // plugin is disabled. Caveat: a flip the user made themselves in
        // Discord settings during the session looks identical and gets
        // restored too; the privacy-safe direction is the one we take.
        if (gateForcedByUs || settings.store.neverShow) {
            try {
                if (ShowCurrentGame.getSetting() !== false) ShowCurrentGame.updateSetting(false);
            } catch { /* settings API gone */ }
        }
        gateForcedByUs = false;
    },

    commands: [
        {
            name: "playing",
            description: "Set your activity to \"Playing <anything>\" (GamePresence). Subcommands: clear / button / party / off",
            options: [
                {
                    type: ApplicationCommandOptionType.STRING, name: "name",
                    description: "Game/app title (leave empty + sub=clear to wipe).", required: false,
                },
                {
                    type: ApplicationCommandOptionType.STRING, name: "verb",
                    description: "playing (default) · streaming · listening · watching · competing", required: false,
                    choices: [
                        { name: "playing", label: "Playing", value: "playing" },
                        { name: "streaming", label: "Streaming", value: "streaming" },
                        { name: "listening", label: "Listening", value: "listening" },
                        { name: "watching", label: "Watching", value: "watching" },
                        { name: "competing", label: "Competing", value: "competing" },
                    ],
                },
                { type: ApplicationCommandOptionType.STRING, name: "details", description: "Line 1 under the title", required: false },
                { type: ApplicationCommandOptionType.STRING, name: "state", description: "Line 2 under the title", required: false },
                { type: ApplicationCommandOptionType.NUMBER, name: "hours", description: "Fake elapsed hours (0 = fresh)", required: false },
                { type: ApplicationCommandOptionType.STRING, name: "party", description: "Player chip like '2 / 5'", required: false },
                {
                    type: ApplicationCommandOptionType.STRING, name: "sub",
                    description: "clear (wipe) · off (disable but keep config)", required: false,
                    choices: [
                        { name: "clear", label: "Clear the activity", value: "clear" },
                        { name: "off", label: "Off (keep config)", value: "off" },
                    ],
                },
            ],
            execute: (args: any[]) => {
                const sub = (findOption(args, "sub") as string | undefined)?.toLowerCase().trim();
                if (sub === "off" || sub === "clear") {
                    settings.store.active = false;
                    if (sub === "clear") settings.store.name = "";
                    apply(sub);
                    return {
                        content: sub === "off"
                            ? "🎮 GamePresence off (config kept — flip **active** in settings or run /playing again)."
                            : "🎮 Activity cleared.",
                    };
                }

                const cfg = cfgFrom(args);
                if (!cfg.name) {
                    return { content: "🎮 Need a name — `/playing Some Game` (or `sub:clear` to wipe)." };
                }

                // write-through to settings so it survives restarts (start() reapplies)
                settings.store.active = true;
                settings.store.name = cfg.name;
                settings.store.verb = cfg.verb;
                settings.store.details = cfg.details ?? "";
                settings.store.state = cfg.state ?? "";
                settings.store.hours = cfg.hours || 0;
                settings.store.party = cfg.party ?? "";
                apply("command");

                const act = currentActivity();
                if (!act) return { content: "🎮 Built nothing (bug?)" };
                const bits = [`**Playing** → ${cfg.name}`];
                if (act.details) bits.push(`line1: ${act.details}`);
                if (act.state) bits.push(`line2: ${act.state}`);
                if (act.party) bits.push(`players: ${act.party.size[0]} / ${act.party.size[1]}`);
                if (cfg.hours > 0) bits.push(`elapsed +${cfg.hours}h`);
                if (act.buttons) bits.push(`buttons: ${act.buttons.length}`);
                const hiddenNote = settings.store.neverShow ? " [HIDDEN: neverShow is on in GamePresence settings]" : "";
                if (!settings.store.neverShow) showToast(`Now showing: ${cfg.name}`);
                return { content: `🎮 ${bits.join(" · ")}${hiddenNote}` };
            },
        },
    ],
});
