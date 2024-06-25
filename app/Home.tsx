'use client'

import { Alchemy, Network, OwnedNft } from "alchemy-sdk";
import { FFmpeg } from "@ffmpeg/ffmpeg"
import { fetchFile, toBlobURL } from "@ffmpeg/util"
import { useRef, useState } from "react"
import Image from "next/image";
import styles from "../styles/Home.module.css";

type CardMetadata = {
  id: string,
  rarity: number,
  faction: number,
  alt: boolean,
  name: string,
};

type MondoOptions = {
  metadata: CardMetadata,
  icon: string,
  favorite: boolean,
  volume: number,
  position: CardPosition,
};

type FfmpegInputFile = {
  name: string,
  path: string | undefined,
};

class FfmpegCommand {
  inputFiles: FfmpegInputFile[];
  args: string[];
  title: string;
  progress: number;
  startTime: number | undefined;
  endTime: number | undefined;

  constructor(
    title: string = "Unnamed Command",
    inputFiles: FfmpegInputFile[] = [],
    args: string[] = [],
  ) {
    this.title = title;
    this.inputFiles = inputFiles;
    this.args = args;
    this.progress = 0.0;
    this.startTime = undefined;
    this.endTime = undefined;
  }
};

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  return ((hours > 0) ? `${hours}h ` : "")
    +    ((hours > 0 || minutes > 0) ? `${minutes}m ` : "")
    +    `${remainingSeconds}s`;
}

// class SpreadTemplate {
//   width: number  = 0;
//   height: number = 0;
// };

// TODO: move these to a SpreadTemplate class instead of having them as constants
const PREVIEW_WIDTH: number = 400;
const PREVIEW_HEIGHT: number = 300;
const TEMPLATE_WIDTH: number = 800;
const TEMPLATE_HEIGHT: number = 600;
const CARD_WIDTH: number = 74;
const CARD_HEIGHT: number = 124;
const CARD_HYP: number = Math.sqrt(CARD_WIDTH * CARD_WIDTH + CARD_HEIGHT * CARD_HEIGHT);
class CardPosition {
  xOffset: number = 0;
  yOffset: number = 0;
  rotation: number = 0;

  /**
   * Creates a new CardPosition. All unspecified parameters will be randomized.
   * 
   * @param x Float scalar for x offset
   * @param y Float scalar for y offset
   * @param r Float angle (in Degrees)
   */
  constructor(x?: number, y?: number, r?: number) {
    /* 
     * TODO replace these literal defines with a specification struct that lets
     * multiple templates reuse the same constructor.
     * 
     * the card preview images are 37px wide and 62.5px tall, and the preview image
     * base canvas is 400px wide and 300px tall. 36.315px is the farthest out ...
     * 
     * (previously) this.pileRandomize(-60 mean, 65 stdev, -190 xmin, 140 xmax, -170 ymin, 110 ymax, -50 xshift, 0 yshift);
     */
    let
      xMean: number = 0.25,   // 0.5 default
      yMean: number = 0.3,    // 0.5 default
      xStdev: number = 0.1625, // 0.1 default
      yStdev: number = 0.1625, // 0.1 default
      xMin: number = 0.0,    // 0.0 default
      xMax: number = 0.71,   // 1.0 default
      yMin: number = 0.0,    // 0.0 default
      yMax: number = 0.82,   // 1.0 default
      rMin: number = 0,      // 0   default
      rMax: number = 360;    // 360 default

    // make sure the random numbers are normally distributed
    // ( see https://en.wikipedia.org/wiki/Box%E2%80%93Muller_transform for the
    // algorithm in use here )
    let r1 = Math.random(), r2 = Math.random();
    this.xOffset = (Math.sqrt(-2.0 * Math.log(r1)) * Math.cos(2.0 * Math.PI * r2) * xStdev) + xMean;
    r1 = Math.random(), r2 = Math.random();
    this.yOffset = (Math.sqrt(-2.0 * Math.log(r1)) * Math.cos(2.0 * Math.PI * r2) * yStdev) + yMean;

    // angles should still always be uniformly distributed
    this.rotation = Math.floor(Math.random() * (rMax - rMin + 1));

    // if min and max values are specified, use them to clamp the previously
    // generated outputs
    if (xMin > this.xOffset) this.xOffset = xMin;
    else if (xMax < this.xOffset) this.xOffset = xMax;
    if (yMin > this.yOffset) this.yOffset = yMin;
    else if (yMax < this.yOffset) this.yOffset = yMax;

    // if parameters are explicitly specified, use those instead
    if (x !== undefined) this.xOffset = x;
    if (y !== undefined) this.yOffset = y;
    if (r !== undefined) this.rotation = r;
  }

  // parameters in Preview Space
  px(): number {
    return Math.floor((this.xOffset * PREVIEW_WIDTH) - (PREVIEW_WIDTH / 2));
  }
  py(): number {
    return Math.floor((this.yOffset * PREVIEW_HEIGHT) - (PREVIEW_HEIGHT / 2));
  }
  pr(): number {
    return this.rotation;
  }

  // parameters in Template Space
  tx(): number {
    return Math.floor((this.xOffset * TEMPLATE_WIDTH) - ((CARD_HYP - CARD_WIDTH) / 2));
  }
  ty(): number {
    return Math.floor((this.yOffset * TEMPLATE_HEIGHT) - ((CARD_HYP - CARD_HEIGHT) / 2));
  }
  tr(): number {
    return this.rotation;
  }
};

const enum ProcessStage {
  START = 0, // base state of the page
  CONFIGURING = 1, // selecting options for the generation step
  GENERATING = 2, // running ffmpeg commands to generate the output video
  PRESENTING = 3, // presenting the completed output video
};
const enum FfmpegStage {
  UNINITIALIZED = 0,
  LOADING = 1,
  LOADED = 2,
  COMMANDED = 3,
};

const FACTION_COUNT = 3;
const enum Faction {
  FAKE_TECH = 1,
  BUM_LEGION_2099 = 2,
  FEMACUBE = 3,
};
const FACTION_NAME: string[] = [
  "",
  "Fake Tech",
  "Bum Legion 2099",
  "F.E.M.A.C.U.B.E.",
];

const DROP_1_CONTRACT = "0xA3A5C1fa196053D5DE78AcFb98238276E546064d";
const DROP_2_CONTRACT = "0x750ee3529D13819E00E4e67063D6e500870d5AF3";
const TOKEN_ID_MAP: Map<string, CardMetadata> = new Map(Object.entries({

  // Fake Tech
  "1": { id: "0001", rarity: 4, faction: 1, alt: false, name: "Wireless Vaccine+-" },
  "2": { id: "0002", rarity: 3, faction: 1, alt: false, name: "DomeHomie Cortical Modem Chip" },
  "3": { id: "0003", rarity: 3, faction: 1, alt: false, name: "ADDERALL® Prescription" },
  "4": { id: "0004", rarity: 3, faction: 1, alt: false, name: "Failed Crowdfunding" },
  "5": { id: "0005", rarity: 1, faction: 1, alt: false, name: "Scientific Proof" },
  "6": { id: "0006", rarity: 1, faction: 1, alt: false, name: "Cell Phone" },
  "7": { id: "0007", rarity: 1, faction: 1, alt: false, name: "Xbox Live Vision Camera (HACKED)" },
  "8": { id: "0008", rarity: 4, faction: 1, alt: false, name: "Time Machine" },
  "9": { id: "0009", rarity: 2, faction: 1, alt: false, name: "Startup Guy" },
  "10": { id: "0010", rarity: 4, faction: 1, alt: false, name: "Social Media Mogul's Beard" },
  "11": { id: "0011", rarity: 3, faction: 1, alt: false, name: "Super Computer 1999" },
  "12": { id: "0012", rarity: 3, faction: 1, alt: false, name: "The Algorithm" },
  "13": { id: "0013", rarity: 1, faction: 1, alt: false, name: "Imposter Moon" },
  "14": { id: "0014", rarity: 4, faction: 1, alt: false, name: "AI Overlord" },
  "15": { id: "0015", rarity: 4, faction: 1, alt: false, name: "Blockchain Tech" },
  "16": { id: "0016", rarity: 2, faction: 1, alt: false, name: "Crapto Currency" },
  "17": { id: "0017", rarity: 4, faction: 1, alt: false, name: "Blockchain Evangelist" },
  "18": { id: "0018", rarity: 5, faction: 1, alt: false, name: "Active Camo" },
  "19": { id: "0019", rarity: 2, faction: 1, alt: false, name: "Power Cell" },
  "20": { id: "0020", rarity: 4, faction: 1, alt: false, name: "GhostTec™ Goop Vial" },
  "21": { id: "0021", rarity: 2, faction: 1, alt: false, name: "GhostTec™ SpectraHub" },
  "22": { id: "0022", rarity: 1, faction: 1, alt: false, name: "GhostTec™ Certification Card" },
  "23": { id: "0023", rarity: 4, faction: 1, alt: false, name: "GhostTec™ HELLmet" },
  "24": { id: "0024", rarity: 4, faction: 1, alt: false, name: "GhostTec™ OdorTizer" },
  "25": { id: "0025", rarity: 3, faction: 1, alt: false, name: "Mars Teleport Sci Institute" },
  "26": { id: "0026", rarity: 2, faction: 1, alt: false, name: "Verbal Word Bullets" },
  "27": { id: "0027", rarity: 1, faction: 1, alt: false, name: "Understandroid" },
  "28": { id: "0028", rarity: 2, faction: 1, alt: false, name: "Internet of Thangs" },
  "29": { id: "0029", rarity: 1, faction: 1, alt: false, name: "Roboid Mental Health Check" },
  "30": { id: "0030", rarity: 2, faction: 1, alt: false, name: "MyGirls™ AI-Generated Girlfriend Experience" },
  "31": { id: "0031", rarity: 3, faction: 1, alt: false, name: "Life Hacks for Dummies" },
  "32": { id: "0032", rarity: 2, faction: 1, alt: false, name: "Intelligence Blockers" },
  "33": { id: "0033", rarity: 2, faction: 1, alt: false, name: "HyperKush Bevlabs" },
  "34": { id: "0034", rarity: 1, faction: 1, alt: false, name: "Power Wand" },
  "35": { id: "0035", rarity: 1, faction: 1, alt: false, name: "Authentic World" },
  "36": { id: "0036", rarity: 3, faction: 1, alt: false, name: "Shitfan" },
  "37": { id: "0037", rarity: 3, faction: 1, alt: false, name: "Disarmer" },
  "38": { id: "0038", rarity: 4, faction: 1, alt: false, name: "Budslugs" },
  "39": { id: "0039", rarity: 1, faction: 1, alt: false, name: "Artisanal Camo" },
  "40": { id: "0040", rarity: 6, faction: 1, alt: false, name: "A Magnet" },
  "41": { id: "0041", rarity: 6, faction: 1, alt: false, name: "Cold-Blooded EVA Suit" },
  "42": { id: "0042", rarity: 4, faction: 1, alt: false, name: "Mannitol Nanomachine Injector" },
  "43": { id: "0043", rarity: 5, faction: 1, alt: false, name: "The Pursuit of Knowledge" },
  "44": { id: "0044", rarity: 2, faction: 1, alt: false, name: "The Living House" },
  "45": { id: "0045", rarity: 5, faction: 1, alt: false, name: "Skillbo Bowlins (Quad-Ought Gauge)" },
  "46": { id: "0046", rarity: 6, faction: 1, alt: false, name: "Guess What LOL" },
  "47": { id: "0047", rarity: 4, faction: 1, alt: false, name: "Does Not Exist!" },
  "48": { id: "0048", rarity: 5, faction: 1, alt: false, name: "Cyber Optic Facemask" },
  "49": { id: "0049", rarity: 1, faction: 1, alt: false, name: "Bogus Freeze Gun" },
  "50": { id: "0050", rarity: 6, faction: 1, alt: false, name: "Lushsux Dix" },
  "51": { id: "0051", rarity: 3, faction: 1, alt: false, name: "Calcuusl" },
  "52": { id: "0052", rarity: 1, faction: 1, alt: false, name: "CAPTCHA Verification" },
  "53": { id: "0053", rarity: 3, faction: 1, alt: false, name: "NASNA Studios" },
  "54": { id: "0054", rarity: 2, faction: 1, alt: false, name: "Electric Chairman" },
  "55": { id: "0055", rarity: 2, faction: 1, alt: false, name: "Rogue Implant" },
  "56": { id: "0056", rarity: 5, faction: 1, alt: false, name: "20mm Hyperkinetic Rounds" },
  "57": { id: "0057", rarity: 3, faction: 1, alt: false, name: "Megamix - an Early 23th Century Zarquanian Dominion Ship-of-the-Line" },
  "58": { id: "0058", rarity: 5, faction: 1, alt: false, name: "Lunar Drillbit" },
  "59": { id: "0059", rarity: 5, faction: 1, alt: false, name: "Research Element 151" },
  "60": { id: "0060", rarity: 3, faction: 1, alt: false, name: "Utopia: Scrupulous Automation" },
  "61": { id: "0061", rarity: 5, faction: 1, alt: false, name: "Fingerprint DNA Backup" },
  "62": { id: "0062", rarity: 1, faction: 1, alt: false, name: "Internal Power Unit" },
  "63": { id: "0063", rarity: 2, faction: 1, alt: false, name: "Restraint Gun" },
  "64": { id: "0064", rarity: 2, faction: 1, alt: false, name: "Polycosmic Manipulation" },
  "65": { id: "0065", rarity: 4, faction: 1, alt: false, name: "Eye of Providence" },
  "66": { id: "0066", rarity: 3, faction: 1, alt: false, name: "TIA Wave Projector" },
  "67": { id: "0067", rarity: 3, faction: 1, alt: false, name: "Roborg the Robot Cyborg" },
  "68": { id: "0068", rarity: 2, faction: 1, alt: false, name: "Armor of Self Confidence" },
  "69": { id: "0069", rarity: 2, faction: 1, alt: false, name: "Cialamin" },
  "70": { id: "0070", rarity: 2, faction: 1, alt: false, name: "Liquid Physics" },
  "71": { id: "0071", rarity: 3, faction: 1, alt: false, name: "Camera Loop" },
  "72": { id: "0072", rarity: 5, faction: 1, alt: false, name: "Gauss Rifle" },
  "73": { id: "0073", rarity: 1, faction: 1, alt: false, name: "Busted Pharmaceutical Kiosk" },
  "74": { id: "0074", rarity: 6, faction: 1, alt: false, name: "Phagic Rebel" },
  "75": { id: "0075", rarity: 1, faction: 1, alt: false, name: "Monocular Supercomputer" },
  "76": { id: "0076", rarity: 2, faction: 1, alt: false, name: "Missionate" },
  "77": { id: "0077", rarity: 5, faction: 1, alt: false, name: "Harp of Conflict" },
  "78": { id: "0078", rarity: 3, faction: 1, alt: false, name: "Hedonic Treadmill" },
  "79": { id: "0079", rarity: 4, faction: 1, alt: false, name: "GMS (Gimme My Space) Mk. III Energy Projector" },
  "80": { id: "0080", rarity: 4, faction: 1, alt: false, name: "Jack & Jill / Vyco and [D.I.N.]" },
  "81": { id: "0081", rarity: 1, faction: 1, alt: false, name: "EcoTactic®: Green Weapons" },
  "82": { id: "0082", rarity: 6, faction: 1, alt: false, name: "Time Cube" },
  "83": { id: "0083", rarity: 1, faction: 1, alt: false, name: "Temperature Regulator" },
  "84": { id: "0084", rarity: 4, faction: 1, alt: false, name: "Hot Potato (Nanite Swarm)" },
  "85": { id: "0085", rarity: 1, faction: 1, alt: false, name: "Amplifier Circuit" },
  "86": { id: "0086", rarity: 2, faction: 1, alt: false, name: "Cecil: The Manic Bike Helmet" },
  "87": { id: "0087", rarity: 2, faction: 1, alt: false, name: "Panopticon You" },
  "88": { id: "0088", rarity: 2, faction: 1, alt: false, name: "APPLY®" },
  "89": { id: "0089", rarity: 2, faction: 1, alt: false, name: "Nopalgarthian Emplacer" },
  "90": { id: "0090", rarity: 1, faction: 1, alt: false, name: "Teleport Tracker" },
  "91": { id: "0091", rarity: 3, faction: 1, alt: false, name: "Stealth Warp" },
  "92": { id: "0092", rarity: 4, faction: 1, alt: false, name: "Portal Formula" },
  "93": { id: "0093", rarity: 3, faction: 1, alt: false, name: "Waypoint Database" },
  "94": { id: "0094", rarity: 1, faction: 1, alt: false, name: "Long Warp" },
  "95": { id: "0095", rarity: 2, faction: 1, alt: false, name: "Economy Warp" },
  "96": { id: "0096", rarity: 3, faction: 1, alt: false, name: "Inscribe and Requite" },
  "97": { id: "0097", rarity: 4, faction: 1, alt: false, name: "Planet B" },
  "98": { id: "0098", rarity: 6, faction: 1, alt: false, name: "Cardboard Robot" },
  "99": { id: "0099", rarity: 3, faction: 1, alt: false, name: "Final Narrative" },
  "100": { id: "0100", rarity: 1, faction: 1, alt: false, name: "Fake Tech" },

  // Fake Tech Rares
  "101": { id: "0006a", rarity: 1, faction: 1, alt: true, name: "Cell Phone - Ad Supported" }, // NEVER MINTED, TITLE IS CONJECTURE
  "102": { id: "0008a", rarity: 4, faction: 1, alt: true, name: "Time Machine - Upside Down" },
  "103": { id: "0011a", rarity: 3, faction: 1, alt: true, name: "Super Computer 1999 - Inverted" },
  "104": { id: "0012a", rarity: 3, faction: 1, alt: true, name: "The Algorithm - Weed Rare" }, // NEVER MINTED, TITLE IS CONJECTURE
  "105": { id: "0017a", rarity: 4, faction: 1, alt: true, name: "Blockchain Evangelist - Drippin" },
  "106": { id: "0019a", rarity: 2, faction: 1, alt: true, name: "Power Cell - Chrome" },
  "107": { id: "0021a", rarity: 2, faction: 1, alt: true, name: "GhostTec™ SpectraHub - Wombo Rare" }, // NEVER MINTED, TITLE IS CONJECTURE
  "108": { id: "0026a", rarity: 2, faction: 1, alt: true, name: "Verbal Word Bullets - Sealed" },
  "109": { id: "0029a", rarity: 1, faction: 1, alt: true, name: "Roboid Mental Health Check - Flash Rare" },
  "110": { id: "0030a", rarity: 2, faction: 1, alt: true, name: "MyGirls™ AI-Generated Girlfriend Experience - Wombo Rare" }, // NEVER MINTED, TITLE IS CONJECTURE
  "111": { id: "0034a", rarity: 1, faction: 1, alt: true, name: "Power Wand - Optical Anachromism Rare" },
  "112": { id: "0037a", rarity: 3, faction: 1, alt: true, name: "Disarmer - Snowglobe" }, // NEVER MINTED, TITLE IS CONJECTURE
  "113": { id: "0040a", rarity: 6, faction: 1, alt: true, name: "A Magnet - Wombo Rare" },
  "114": { id: "0041a", rarity: 6, faction: 1, alt: true, name: "Cold-Blooded EVA Suit - Glitched" },
  "115": { id: "0042a", rarity: 4, faction: 1, alt: true, name: "Mannitol Nanomachine Injector - Non-Animated" },
  "116": { id: "0049a", rarity: 1, faction: 1, alt: true, name: "Bogus Freeze Gun - Glitched" },
  "117": { id: "0057a", rarity: 3, faction: 1, alt: true, name: "Megamix - an Early 23th Century Zarquanian Dominion Ship-of-the-Line - Drippin" }, // NEVER MINTED, TITLE IS CONJECTURE
  "118": { id: "0058a", rarity: 5, faction: 1, alt: true, name: "Lunar Drillbit - Wombo Rare" },
  "119": { id: "0064a", rarity: 2, faction: 1, alt: true, name: "Polycosmic Manipulation - You Know it\'s Rare" },
  "120": { id: "0068a", rarity: 2, faction: 1, alt: true, name: "Armor of Self Confidence - Upside Down" }, // NEVER MINTED, TITLE IS CONJECTURE
  "121": { id: "0069a", rarity: 2, faction: 1, alt: true, name: "Cialamin - Ad Supported" },
  "122": { id: "0073a", rarity: 1, faction: 1, alt: true, name: "Busted Pharmaceutical Kiosk - Little Guy Edition" },
  "123": { id: "0074a", rarity: 6, faction: 1, alt: true, name: "Phagic Rebel - Optical Anachromism Rare" },
  "124": { id: "0077a", rarity: 5, faction: 1, alt: true, name: "Harp of Conflict - Little Guy Edition" },
  "125": { id: "0079a", rarity: 4, faction: 1, alt: true, name: "GMS (Gimme My Space) Mk. III Energy Projector - Drunk" },
  "126": { id: "0085a", rarity: 1, faction: 1, alt: true, name: "Amplifier Circuit - Inverted" },
  "127": { id: "0087a", rarity: 2, faction: 1, alt: true, name: "Panopticon You - Gold Perfect Rare" },
  "128": { id: "0090a", rarity: 1, faction: 1, alt: true, name: "Teleport Tracker - Little Guy Edition" },
  "129": { id: "0092a", rarity: 4, faction: 1, alt: true, name: "Portal Formula - Inverted" },
  "130": { id: "0093a", rarity: 3, faction: 1, alt: true, name: "Waypoint Database - Snowglobe" },
  //"???": { id:"0094a", rarity:1, faction:1, alt:true, name:"Long Warp - Inverted" }, // NEVER MINTED, TITLE IS CONJECTURE

  // Bum Legion 2099
  "131": { id: "0101", rarity: 3, faction: 2, alt: false, name: "The Tools You Need" },
  "132": { id: "0102", rarity: 3, faction: 2, alt: false, name: "Raw Truth" },
  "133": { id: "0103", rarity: 1, faction: 2, alt: false, name: "Bum Army" },
  "134": { id: "0104", rarity: 4, faction: 2, alt: false, name: "Phonebook Armor" },
  "135": { id: "0105", rarity: 6, faction: 2, alt: false, name: "No Good Deed" },
  "136": { id: "0106", rarity: 2, faction: 2, alt: false, name: "Russian Bum Fire" },
  "137": { id: "0107", rarity: 6, faction: 2, alt: false, name: "Armor of Don Quixote" },
  "138": { id: "0108", rarity: 6, faction: 2, alt: false, name: "Badd Notification" },
  "139": { id: "0109", rarity: 2, faction: 2, alt: false, name: "Survival Arts" },
  "140": { id: "0110", rarity: 3, faction: 2, alt: false, name: "Extra Gas" },
  "141": { id: "0111", rarity: 4, faction: 2, alt: false, name: "King of Dogs" },
  "142": { id: "0112", rarity: 2, faction: 2, alt: false, name: "Tweaked" },
  "143": { id: "0113", rarity: 4, faction: 2, alt: false, name: "Dirty Hypo Needles" },
  "144": { id: "0114", rarity: 1, faction: 2, alt: false, name: "Open Manhole" },
  "145": { id: "0115", rarity: 6, faction: 2, alt: false, name: "The Actor's Curse" },
  "146": { id: "0116", rarity: 5, faction: 2, alt: false, name: "Psychic Hobo Initiation" },
  "147": { id: "0117", rarity: 3, faction: 2, alt: false, name: "Human Shield" },
  "148": { id: "0118", rarity: 6, faction: 2, alt: false, name: "Jenkem Whippet" },
  "149": { id: "0119", rarity: 3, faction: 2, alt: false, name: "Sky Bums" },
  "150": { id: "0120", rarity: 4, faction: 2, alt: false, name: "TK Knight" },
  "151": { id: "0121", rarity: 4, faction: 2, alt: false, name: "Ditch Contraband" },
  "152": { id: "0122", rarity: 1, faction: 2, alt: false, name: "Flash Suicide - Phone Switcheroo" },
  "153": { id: "0123", rarity: 6, faction: 2, alt: false, name: "Flash Suicide - Horizontal Lynching" },
  "154": { id: "0124", rarity: 5, faction: 2, alt: false, name: "Flash Suicide - Taste It" },
  "155": { id: "0125", rarity: 1, faction: 2, alt: false, name: "Cigarette Bum" },
  "156": { id: "0126", rarity: 6, faction: 2, alt: false, name: "Public Computer Access" },
  "157": { id: "0127", rarity: 4, faction: 2, alt: false, name: "Wet Garbage Ghillie Suit" },
  "158": { id: "0128", rarity: 1, faction: 2, alt: false, name: "The Man with the Golden Voice / Obama Redux" },

  // Femacube
  "159": { id: "0129", rarity: 3, faction: 3, alt: false, name: "Intro to Crisis Acting 101" },
  "160": { id: "0130", rarity: 3, faction: 3, alt: false, name: "1-800-WE-HELP-U" },
  "161": { id: "0131", rarity: 5, faction: 3, alt: false, name: "The Great Reset" },
  "162": { id: "0132", rarity: 3, faction: 3, alt: false, name: "The Museum" },
  "163": { id: "0133", rarity: 1, faction: 3, alt: false, name: "Red Tape" },
  "164": { id: "0134", rarity: 3, faction: 3, alt: false, name: "B-rock \"The Islamic Shock\" Hussein O-Bomb-Ya" },
  "165": { id: "0135", rarity: 4, faction: 3, alt: false, name: "Bruydac" },
  "166": { id: "0136", rarity: 3, faction: 3, alt: false, name: "Bruydac: Lehns-Vult" },
  "167": { id: "0137", rarity: 2, faction: 3, alt: false, name: "Bruydac: Xin Dynasty" },
  "168": { id: "0138", rarity: 1, faction: 3, alt: false, name: "Bruydac: Varyags" },
  "169": { id: "0139", rarity: 3, faction: 3, alt: false, name: "Bruydac: Shizmadu Traces" },
  "170": { id: "0140", rarity: 1, faction: 3, alt: false, name: "Bruydac: Operations - Sequence I" },
  "171": { id: "0141", rarity: 5, faction: 3, alt: false, name: "Bruydac: Operations - Sequence II" },
  "172": { id: "0142", rarity: 4, faction: 3, alt: false, name: "Evolutionary Paths" },
  "173": { id: "0143", rarity: 5, faction: 3, alt: false, name: "NEWSBOP" },
  "174": { id: "0144", rarity: 2, faction: 3, alt: false, name: "Monkey Terrorists" },
  "175": { id: "0145", rarity: 1, faction: 3, alt: false, name: "The Agency of Small Evenly-Distributed Pools of Water" },
  "176": { id: "0146", rarity: 1, faction: 3, alt: false, name: "F E M A C U B E C O R P O R A T E P S Y C H E V A L U A T I O N Page1" },
  "177": { id: "0147", rarity: 2, faction: 3, alt: false, name: "F E M A C U B E C O R P O R A T E P S Y C H E V A L U A T I O N Page2" },
  "178": { id: "0148", rarity: 3, faction: 3, alt: false, name: "F E M A C U B E C O R P O R A T E P S Y C H E V A L U A T I O N Page3" },
  "179": { id: "0149", rarity: 5, faction: 3, alt: false, name: "Fake Alien Abduction (Trumanned President)" },
  "180": { id: "0150", rarity: 1, faction: 3, alt: false, name: "Fake Iraq (Trumanned President)" },
  "181": { id: "0151", rarity: 4, faction: 3, alt: false, name: "Fake Moon (Trumanned President)" },
  "182": { id: "0152", rarity: 5, faction: 3, alt: false, name: "FedFinder HOME ADDRESS SOCIAL SECURITY NUMBER" },
  "183": { id: "0153", rarity: 3, faction: 3, alt: false, name: "Brain Scorchers" },
  "184": { id: "0154", rarity: 2, faction: 3, alt: false, name: "Sheeple Scanner" },
  "185": { id: "0155", rarity: 3, faction: 3, alt: false, name: "Social Media Court" },
  "186": { id: "0156", rarity: 6, faction: 3, alt: false, name: "The Dial-Up Men" },
  "187": { id: "0157", rarity: 1, faction: 3, alt: false, name: "\"Food\"" },
  "188": { id: "0158", rarity: 1, faction: 3, alt: false, name: "Lockdown (Low)" },
  "189": { id: "0159", rarity: 2, faction: 3, alt: false, name: "Lockdown (Guarded)" },
  "190": { id: "0160", rarity: 3, faction: 3, alt: false, name: "Lockdown (Elevated)" },
  "191": { id: "0161", rarity: 4, faction: 3, alt: false, name: "Lockdown (High)" },
  "192": { id: "0162", rarity: 5, faction: 3, alt: false, name: "Lockdown (Standard)" },
  "193": { id: "0163", rarity: 1, faction: 3, alt: false, name: "Mindwipe Pill" },
  "194": { id: "0164", rarity: 6, faction: 3, alt: false, name: "NT Mineral Reclamation Asteroid B-73" },
  "195": { id: "0165", rarity: 4, faction: 3, alt: false, name: "Calamity Blast" },
  "196": { id: "0166", rarity: 4, faction: 3, alt: false, name: "CIA Child Soldier" },
  "197": { id: "0167", rarity: 2, faction: 3, alt: false, name: "Sandy Hookers" },
  "198": { id: "0168", rarity: 5, faction: 3, alt: false, name: "Reverse Universe" },
  "199": { id: "0169", rarity: 3, faction: 3, alt: false, name: "GATE Program" },
  "200": { id: "0170", rarity: 4, faction: 3, alt: false, name: "Gas Station Adrenochrome" },
  "201": { id: "0171", rarity: 2, faction: 3, alt: false, name: "Gay Terminator" },
  "202": { id: "0172", rarity: 4, faction: 3, alt: false, name: "ChillX Hypo-Pistol" },
  "203": { id: "0173", rarity: 2, faction: 3, alt: false, name: "CIA 1 (Dark Red): The Central Information Army" },
  "204": { id: "0174", rarity: 2, faction: 3, alt: false, name: "CIA 2 (Dark Blue): The Chief Investigation Agency" },
  "205": { id: "0175", rarity: 4, faction: 3, alt: false, name: "CIA 3 (Dark Green): The Commission of Intelligence Authorization" },
  "206": { id: "0176", rarity: 1, faction: 3, alt: false, name: "Depopulation/Killshot" },
  "207": { id: "0177", rarity: 2, faction: 3, alt: false, name: "Moralize" },
  "208": { id: "0178", rarity: 1, faction: 3, alt: false, name: "Poison Pen" },
  "209": { id: "0179", rarity: 3, faction: 3, alt: false, name: "\'Nati Pop" },
  "210": { id: "0180", rarity: 1, faction: 3, alt: false, name: "Demonic Centrifuge" },
  "211": { id: "0181", rarity: 1, faction: 3, alt: false, name: "Airplane Mass Shooting Tutorial Mission" },
  "212": { id: "0182", rarity: 2, faction: 3, alt: false, name: "Commonplace Cannibalism" },
  "213": { id: "0183", rarity: 2, faction: 3, alt: false, name: "Credible Threat Generator" },
  "214": { id: "0184", rarity: 2, faction: 3, alt: false, name: "DigiSnitch" },
  "215": { id: "0185", rarity: 1, faction: 3, alt: false, name: "Daylight Savings" },
  "216": { id: "0186", rarity: 4, faction: 3, alt: false, name: "The FEMACUBE³" },
  "217": { id: "0187", rarity: 3, faction: 3, alt: false, name: "IRS Stormtrooper" },
  "218": { id: "0188", rarity: 6, faction: 3, alt: false, name: "Trumanning the President" },
  "219": { id: "0189", rarity: 2, faction: 3, alt: false, name: "Wave Check Point" },
  "220": { id: "0190", rarity: 3, faction: 3, alt: false, name: "Gay Gun Control Crisis Boy" },
  "221": { id: "0191", rarity: 2, faction: 3, alt: false, name: "Gifted Children\'s Research Program" },
  "222": { id: "0192", rarity: 5, faction: 3, alt: false, name: "Elite Bomb Shelter" },
  "223": { id: "0193", rarity: 3, faction: 3, alt: false, name: "Homeland Security Sexual Threat Scale" },
  "224": { id: "0194", rarity: 2, faction: 3, alt: false, name: "FEMACUBE Vivisection Colony 821a Major" },
  "225": { id: "0195", rarity: 3, faction: 3, alt: false, name: "Forced Sterilization" },
  "226": { id: "0196", rarity: 1, faction: 3, alt: false, name: "Terrorist Training Simulator" },
  "227": { id: "0197", rarity: 2, faction: 3, alt: false, name: "Water Crisis" },
  "228": { id: "0198", rarity: 2, faction: 3, alt: false, name: "What to Do If There\'s a Shooter" },
  "229": { id: "0199", rarity: 4, faction: 3, alt: false, name: "World Health Organization Satellite Realm B" },
  "230": { id: "0200", rarity: 3, faction: 3, alt: false, name: "Israeli Art Student" },
  "231": { id: "0201", rarity: 1, faction: 3, alt: false, name: "Lazarus Rejuvenation" },
  "232": { id: "0202", rarity: 1, faction: 3, alt: false, name: "False Flag Attack" },
  "233": { id: "0203", rarity: 2, faction: 3, alt: false, name: "FOSTER, TERRY Incident Report 1a" },
  "234": { id: "0204", rarity: 2, faction: 3, alt: false, name: "FOSTER, TERRY Incident Report 1b" },
  "235": { id: "0205", rarity: 3, faction: 3, alt: false, name: "FOSTER, TERRY Incident Report 1c" },
  "236": { id: "0206", rarity: 1, faction: 3, alt: false, name: "FunVax" },
  "237": { id: "0207", rarity: 1, faction: 3, alt: false, name: "G.I.D." },
  "238": { id: "0208", rarity: 2, faction: 3, alt: false, name: "Let\'s Start Over" },
  "239": { id: "0209", rarity: 5, faction: 3, alt: false, name: "MegaNet: You're Gonna Love This Net™" },
  "240": { id: "0210", rarity: 3, faction: 3, alt: false, name: "Power Plant Meltdown" },
  "241": { id: "0211", rarity: 2, faction: 3, alt: false, name: "Protection Threat" },
  "242": { id: "0212", rarity: 1, faction: 3, alt: false, name: "Robocall from the President" },
  "243": { id: "0213", rarity: 5, faction: 3, alt: false, name: "Sequencing Database" },
  "244": { id: "0214", rarity: 1, faction: 3, alt: false, name: "Sheeple Chipper" },
  "245": { id: "0215", rarity: 2, faction: 3, alt: false, name: "Targeted Individual Database" },
  "246": { id: "0216", rarity: 1, faction: 3, alt: false, name: "Targeted Mutations" },
  "247": { id: "0217", rarity: 4, faction: 3, alt: false, name: "Schtephen Hawkin" },
  "248": { id: "0218", rarity: 6, faction: 3, alt: false, name: "Caged Ragist" },
  "249": { id: "0219", rarity: 4, faction: 3, alt: false, name: "FedGov MyBuddy Mobile" },
  "250": { id: "0220", rarity: 5, faction: 3, alt: false, name: "Resonant Mesh" },
  "251": { id: "0221", rarity: 6, faction: 3, alt: false, name: "Lab Red Keycard" },

}));

const mondoRaritySort = (a: CardMetadata, b: CardMetadata) => {
  if (a.alt == b.alt) {

    let aScore = (FACTION_COUNT * a.rarity) - a.faction;
    let bScore = (FACTION_COUNT * b.rarity) - b.faction;
    if (aScore > bScore) { return -1; }
    else if (aScore < bScore) { return 1; }
    else { return 0; }

  } else {

    return a.alt ? -1 : 1;

  }
};

const alchemyConfig = {
  apiKey: process.env.ALCHEMY_API_KEY,
  network: Network.ETH_MAINNET,
};
const alchemy = new Alchemy(alchemyConfig);

export default function Home() {
  // process state
  const [processStage, setProcessStage] = useState<ProcessStage>(ProcessStage.START);
  // ffmpeg state
  const [ffmpegStage, setFfmpegStage] = useState<FfmpegStage>(FfmpegStage.UNINITIALIZED);
  const ffmpegRef = useRef(new FFmpeg());
  const blobUrlMapRef = useRef<Map<string, string>>(new Map<string, string>());
  const [outputVideoLink, setOutputVideoLink] = useState<string>("");
  const [ffmpegCommandQueue, setFfmpegCommandQueue] = useState<FfmpegCommand[]>([]);
  // mondo state
  const [isLoadingMondoAssets, setIsLoadingMondoAssets] = useState(false);
  const [isLoadingNfts, setIsLoadingNfts] = useState(false);
  const [errorLoadingNfts, setErrorLoadingNfts] = useState<string>("");
  const [ethAddress, setEthAddress] = useState("0x0000000000000000000000000000000000000000");
  // options state
  const [mondoOptions, setMondoOptions] = useState<MondoOptions[]>([]);
  const [highlightedCard, setHighlightedCard] = useState<number>(-1);


  const initialize = async () => {
    // clear any previous errors
    setErrorLoadingNfts("");

    // load ffmpeg
    if (ffmpegStage < FfmpegStage.LOADED) {
      setFfmpegStage(FfmpegStage.LOADING);
      //TODO: fix multithreading
      // const baseURL = "https://unpkg.com/@ffmpeg/core-mt@0.12.6/dist/umd";
      const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd";
      const ffmpeg = ffmpegRef.current;
      await ffmpeg
        .load({
          coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
          wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
          //workerURL: await toBlobURL(`${baseURL}/ffmpeg-core.worker.js`, "text/javascript"),
        })
        .then(() => setFfmpegStage(FfmpegStage.LOADED))
        .catch((e) => {
          setFfmpegStage(FfmpegStage.UNINITIALIZED);
          console.error(`ERROR INITIALIZING FFMPEG:\n${e}`);
        });
    }

    // grab all Mondos owned by the user
    setIsLoadingNfts(true);
    try {
      let addr = `${ethAddress}`;
      let nftBuffer: OwnedNft[][] = [];
      let nextKey = null;
      let nextResponse = null;
      do {
        if (nextKey === null) {
          nextResponse = await alchemy.nft.getNftsForOwner(addr, {
            contractAddresses: [DROP_1_CONTRACT, DROP_2_CONTRACT],
          });
        } else {
          nextResponse = await alchemy.nft.getNftsForOwner(addr, {
            contractAddresses: [DROP_1_CONTRACT, DROP_2_CONTRACT],
            pageKey: nextKey,
          });
        }
        nftBuffer.push(nextResponse.ownedNfts);
        nextKey = nextResponse.pageKey;
      } while (nextKey != null);
      const nfts: OwnedNft[] = nftBuffer.flat();

      // if the user has no mondos, say so
      if (nfts.length == 0) {
        setIsLoadingNfts(false);
        setErrorLoadingNfts("That address has 0 (zero) Mondos! How embarrassing...");
        return;
      }

      // convert to the clean metadata for the mondo list
      const cleanMetadata = nfts
        .map(nft => {
          let mtd = TOKEN_ID_MAP.get(nft.tokenId);
          let output: CardMetadata[] = [];
          if (mtd === null || mtd === undefined) {
            return output;
          } else {
            let count = parseInt(nft.balance);
            for (let i = count; i > 0; i--) {
              output.push(mtd);
            }
            return output;
          }
        })
        .flat()
        .sort(mondoRaritySort);

      // update the options table
      const optionsRows = cleanMetadata.map(mtd => {
        let rar = mtd.alt ? "alt" : `r${mtd.rarity}`;
        let fac = "ft";
        if (mtd.faction == Faction.BUM_LEGION_2099) fac = "bl";
        else if (mtd.faction == Faction.FEMACUBE) fac = "fc";
        let output: MondoOptions = {
          metadata: mtd,
          icon: `/icons/rarity/${rar}_${fac}.png`,
          favorite: false,
          volume: 1.0,
          position: new CardPosition(),
        };
        return output;
      });
      setMondoOptions(optionsRows);

    } catch (error) {
      setErrorLoadingNfts(`${error}`);
      setIsLoadingNfts(false);
      return;
    }
    setIsLoadingNfts(false);

    // advance to the next processing stage
    setProcessStage(ProcessStage.CONFIGURING);
  };

  const handleFavoriteChange = (i: number) => {
    if (mondoOptions[i].favorite) {
      const newRows = [...mondoOptions];
      newRows[i].favorite = false;
      setMondoOptions(newRows);
    } else {
      const newRows = mondoOptions.map(mondo => {
        mondo.favorite = false;
        return mondo;
      });
      newRows[i].favorite = !newRows[i].favorite;
      setMondoOptions(newRows);
    }
  };

  const rerollCardLocation = (i: number) => {
    const newRows = [...mondoOptions];
    newRows[i].position = new CardPosition();
    setMondoOptions(newRows);
  }
  const rerollAllCardLocations = () => {
    const newRows = mondoOptions.map(mondo => {
      mondo.position = new CardPosition();
      return mondo;
    });
    setMondoOptions(newRows);
  };

  const OVERFLOW_CHUNK_SIZE = 8;
  const generateFfmpegCommands = () => {
    // prep
    const favoriteId = (mondoOptions.some((mondo: MondoOptions) => mondo.favorite))
      ? mondoOptions.filter((mondo: MondoOptions) => mondo.favorite)[0].metadata.id
      : undefined;
    const commands: FfmpegCommand[] = [];

    // group ffmpeg filtergraph steps into chunks to avoid overloading the
    // internal memory limits for ffmpeg.wasm (chunk size defined as const)
    //  2 -> [..]                       -> runtSize=2, numChunks=0
    //  8 -> [........]                 -> runtSize=8, numChunks=0
    //  9 -> [.][........]              -> runtSize=1, numChunks=1
    // 16 -> [........][........]       -> runtSize=8, numChunks=1
    // 20 -> [....][........][........] -> runtSize=4, numChunks=2
    let runtSize = (mondoOptions.length % OVERFLOW_CHUNK_SIZE == 0)
      ? OVERFLOW_CHUNK_SIZE
      : mondoOptions.length % OVERFLOW_CHUNK_SIZE;
    let numChunks = Math.floor((mondoOptions.length - 1) / OVERFLOW_CHUNK_SIZE);

    // generate audio mixing commands
    let runtCardsA = mondoOptions
      .slice(0, runtSize);
    commands.push(new FfmpegCommand(
      `Audio mixing (1/${numChunks + 1})`,
      [
        {
          name: "ambiance.wav",
          path: "/templates/picnic/ambiance.wav",
        },
        ...runtCardsA
          .map((card: MondoOptions, i: number) => ({
            name: `card_${i}.mp4`,
            path: `/cards/${card.metadata.id}.mp4`,
          }))
      ],
      [
        "-i", "ambiance.wav",
        ...runtCardsA
          .flatMap((_, i: number) =>
            ["-i", `card_${i}.mp4`]
          ),
        "-vn",
        "-filter_complex", `amix=inputs=${runtSize + 1}:duration=first:weights='${runtCardsA
          .reduce((acc, cur) => acc + (
            (favoriteId === undefined)
              ? " 0.01"
              : (cur.favorite)
                ? " 0.025"
                : " 0.0025"
          ),
            "1",
          )
        }'`,
        (numChunks === 0)
          ? "audio_final.wav"
          : "audio_0.wav",
      ],
    ));
    for (let chunk = 0; chunk < numChunks; chunk++) {
      let offset = runtSize + (chunk * OVERFLOW_CHUNK_SIZE);
      let chunkCardsA = mondoOptions
        .slice(offset, offset + OVERFLOW_CHUNK_SIZE);
      commands.push(new FfmpegCommand(
        `Audio mixing (${chunk + 2}/${numChunks + 1})`,
        [
          {
            name: `audio_${chunk}.wav`,
            path: undefined,
          },
          ...chunkCardsA
            .map((card: MondoOptions, i: number) => ({
              name: `card_${offset + i}.mp4`,
              path: `/cards/${card.metadata.id}.mp4`,
            }))
        ],
        [
          "-i", `audio_${chunk}.wav`,
          ...chunkCardsA
            .flatMap((_, i: number) =>
              ["-i", `card_${offset + i}.mp4`]
            ),
          "-vn",
          "-filter_complex", `amix=inputs=${OVERFLOW_CHUNK_SIZE + 1}:duration=first:weights='${chunkCardsA
            .reduce((acc, cur) => acc + (
              (favoriteId === undefined)
                ? " 0.01"
                : (cur.favorite)
                  ? " 0.025"
                  : " 0.0025"
            ),
              "1",
            )
          }'`,
          (chunk === numChunks - 1)
            ? "audio_final.wav"
            : `audio_${chunk + 1}.wav`,
        ],
      ));
    }

    // generate video rendering and compositing commands
    let runtCards = [...mondoOptions]
      .reverse()
      .slice(0, runtSize)
      .filter(card => !card.favorite);
    commands.push(new FfmpegCommand(
      `Video rendering (1/${numChunks + 1})`,
      [
        {
          name: "bg.png",
          path: "/templates/picnic/bg_800x600.png",
        },
        ...runtCards
          .map((card: MondoOptions, i: number) => ({
            name: `card_${i}.mp4`,
            path: `/cards/${card.metadata.id}.mp4`,
          }))
      ],
      [
        "-i", "bg.png",
        ...runtCards
          .flatMap((_, i: number) =>
            ["-i", `card_${i}.mp4`]
          ),
        "-an",
        "-filter_complex", `${runtCards
          .map((card: MondoOptions, i: number) =>
            `[${i + 1}:v]format=bgra,scale=74:124:flags=neighbor,rotate=${card.position.tr()}*PI/180:c=none:ow=hypot\\(iw\\,ih\\):oh=ow:bilinear=1[rc${i}];`
          )
          .reduce((acc, cur) => acc + cur, "")
        }[0:v]${runtCards
          .map((card: MondoOptions, i: number, arr: MondoOptions[]) =>
            (i === arr.length - 1)
              ? `[rc${i}]overlay=${card.position.tx()}:${card.position.ty()}[cmplt]`
              : `[rc${i}]overlay=${card.position.tx()}:${card.position.ty()}[oc${i}];[oc${i}]`
          )
          .reduce((acc, cur) => acc + cur, "")
        }`,
        "-map", "[cmplt]",
        (numChunks === 0)
          ? "video_allcards.mp4"
          : "video_0.mp4",
      ],
    ));
    for (let chunk = 0; chunk < numChunks; chunk++) {
      let offset = runtSize + (chunk * OVERFLOW_CHUNK_SIZE);
      let chunkCards = [...mondoOptions]
        .reverse()
        .slice(offset, offset + OVERFLOW_CHUNK_SIZE)
        .filter(card => !card.favorite);
      commands.push(new FfmpegCommand(
        `Video rendering (${chunk + 2}/${numChunks + 1})`,
        [
          {
            name: `video_${chunk}.mp4`,
            path: undefined,
          },
          ...chunkCards
            .map((card: MondoOptions, i: number) => (
              {
                name: `card_${offset + i}.mp4`,
                path: `/cards/${card.metadata.id}.mp4`,
              }
            ))
        ],
        [
          "-i", `video_${chunk}.mp4`,
          ...chunkCards
            .flatMap((_, i: number) =>
              ["-i", `card_${offset + i}.mp4`]
            ),
          "-an",
          "-filter_complex", `${chunkCards
            .map((card: MondoOptions, i: number) =>
              `[${i + 1}:v]format=bgra,scale=74:124:flags=neighbor,rotate=${card.position.tr()}*PI/180:c=none:ow=hypot\\(iw\\,ih\\):oh=ow:bilinear=1[rc${i}];`
            )
            .reduce((acc, cur) => acc + cur, "")
          }[0:v]${chunkCards
            .map((card: MondoOptions, i: number, arr: MondoOptions[]) =>
              (i === arr.length - 1)
                ? `[rc${i}]overlay=${card.position.tx()}:${card.position.ty()}[cmplt]`
                : `[rc${i}]overlay=${card.position.tx()}:${card.position.ty()}[oc${i}];[oc${i}]`
            )
            .reduce((acc, cur) => acc + cur, "")
          }`,
          "-map", "[cmplt]",
          (chunk === numChunks - 1)
            ? (favoriteId === undefined)
              ? "video_final.mp4"
              : "video_allcards.mp4"
            : `video_${chunk + 1}.mp4`,
        ],
      ));
    }
    if (favoriteId !== undefined) {
      commands.push(new FfmpegCommand(
        "Overlay Favorite Card",
        [
          {
            name: "video_allcards.mp4",
            path: undefined,
          },
          {
            name: "h1.png",
            path: "/templates/picnic/h1_800x600.png",
          },
          {
            name: "h2.png",
            path: "/templates/picnic/h2_800x600.png",
          },
          {
            name: "fav.mp4",
            path: `/cards/${favoriteId}.mp4`,
          },
        ],
        [
          "-i", "video_allcards.mp4",
          "-i", "h1.png",
          "-i", "h2.png",
          "-i", "fav.mp4",
          "-an",
          "-filter_complex", "[3:v]format=bgra,rotate=350*PI/180:c=none:ow=rotw(350*PI/180):oh=roth(350*PI/180):bilinear=0[fav];[0:v][1:v]overlay=0:0[f1];[f1][fav]overlay=373:138[f2];[f2][2:v]overlay=0:0[final]",
          "-map", "[final]",
          "video_final.mp4",
        ],
      ));
    }

    // add the final assembly command to the queue
    commands.push(new FfmpegCommand(
      "Combine Audio and Video streams",
      [
        {
          name: "video_final.mp4",
          path: undefined,
        },
        {
          name: "audio_final.wav",
          path: undefined,
        },
      ],
      [
        "-i", "video_final.mp4",
        "-i", "audio_final.wav",
        "-c:v", "libx264",
        "-crf", "20",
        "-map", "0:v:0",
        "-map", "1:a:0",
        "output.mp4",
      ],
    ));

    //DEBUG
    console.log(commands);

    // update page state with the full command list
    setFfmpegCommandQueue(commands);
    setFfmpegStage(FfmpegStage.COMMANDED);
  }
  const runFfmpegCommand = async (i: number): Promise<boolean> => {
    // safety checks
    if (ffmpegCommandQueue[i].args.length === 0) {
      throw new Error("FfmpegCommand is missing args");
    }

    // initialize
    let ffmpeg = ffmpegRef.current;
    let blobDict = blobUrlMapRef.current;
    ffmpegCommandQueue[i].startTime = Date.now();
    //console.log(`RUNNING "${ffmpegCommandQueue[i].title}"`);//DEBUG
    const progressHandler = ({ progress, time }: any) => {
      const newCommandQueue = [...ffmpegCommandQueue];
      newCommandQueue[i].progress = progress;
      setFfmpegCommandQueue(newCommandQueue);
    }
    ffmpeg.on('progress', progressHandler);

    try {
      // load inputs
      await Promise.all(
        ffmpegCommandQueue[i].inputFiles.map(async f => {
          const fileData = await fetchFile(
            f.path === undefined ? blobDict.get(f.name) : f.path
          );
          return ffmpeg.writeFile(f.name, fileData);
        })
      );

      // execute
      await ffmpeg.exec(ffmpegCommandQueue[i].args);
      ffmpegCommandQueue[i].progress = 1.0;

      // read the output
      let outputFileName = ffmpegCommandQueue[i].args[ffmpegCommandQueue[i].args.length - 1];
      let outputRaw = await ffmpeg.readFile(outputFileName) as any;
      let outputUrl = URL.createObjectURL(new Blob([outputRaw.buffer]));
      blobDict.set(outputFileName, outputUrl);

      // clean up
      ffmpeg.off("progress", progressHandler);
      await Promise.all([
        ...ffmpegCommandQueue[i].inputFiles.map(f => ffmpeg.deleteFile(f.name)),
        ffmpeg.deleteFile(outputFileName),
      ]);

      ffmpegCommandQueue[i].endTime = Date.now();
      return true;
    } catch (error) {
      ffmpeg.off("progress", progressHandler);
      throw error; // Re-throw the error to be caught by the caller
    }
  }

  const generateSpread = async () => {
    setProcessStage(ProcessStage.GENERATING);
    const ffmpeg = ffmpegRef.current;
    const blobUrlMap = blobUrlMapRef.current;
    ffmpeg.on("log", log => console.log(log.message));

    // run the queued ffmpeg commands
    for (let i = 0; i < ffmpegCommandQueue.length; i++) {
      try {
        await runFfmpegCommand(i);
      } catch (err) {
        console.error(`Failed on command ${i}:\n${ffmpegCommandQueue[i]}`);
        return;
      }
    }

    // wipe the blob dict
    //TODO move this to inside of FfmpegCommand.run() so memory use doesn't climb as the program runs
    blobUrlMap.forEach((url: string, key: string) => (key === "output.mp4") ? {} : URL.revokeObjectURL(url));

    // grab the output video URL so it can be displayed
    let output = blobUrlMap.get("output.mp4");
    if (output === undefined) {
      console.error(`Failed to retrieve final video URL`);
      return;
    } else {
      setOutputVideoLink(output);
    }


    // finalize state
    setProcessStage(ProcessStage.PRESENTING);
  }

  // hide and display elements for each step of the process
  switch (processStage) {
    // ========================================================================
    case ProcessStage.PRESENTING:
      return <div className={styles.pageContainer}>
        <div className={styles.outputVideoWrapper}>
          <video src={outputVideoLink} controls/>
        </div>
      </div>



    // ========================================================================
    case ProcessStage.GENERATING:
      return <div className={styles.pageContainer}>
        {/* <p>{ffmpegConsoleOutput}</p> */}
        <div className={styles.generatingTableContainer}>
          <table className={styles.table}>
            {/* <thead>
              <tr>
                <th>Status</th>
                <th>Title</th>
                <th>Progress</th>
                <th>Time Elapsed</th>
              </tr>
            </thead> */}
            <tbody>
              {ffmpegCommandQueue.map((command, index) => (
                <tr
                  key={index}
                  className={`${command.progress != 1.0 ? styles.generatingUnfinishedRow : ""}`}
                >
                  <td className={styles.loadingIconCell}>
                    {(command.startTime == null)
                      ? <div className={styles.loadingIconCellPair}>
                        <img src="/icons/gear.png" className={styles.generatingUnfinished} />
                      </div>
                      : ((command.endTime == null)
                        ? <div className={styles.loadingIconCellPair}>
                          <img src="/icons/gear.png" className={styles.generatingWorking} />
                          <img src="/icons/loading.gif" className={styles.startLoadingGif} />
                        </div>
                        : <div className={styles.loadingIconCellPair}>
                          <img src="/icons/gear.png"/>
                        </div>
                      )
                    }
                  </td>
                  <td className={styles.longCell}>
                    <p>
                      {command.title}
                    </p>
                  </td>
                  <td className={styles.infoCell}>
                    <p>
                      {`${(command.progress * 100).toFixed(2)}\%`}
                    </p>
                  </td>
                  <td className={styles.infoCell}>
                    <p>
                      {(command.startTime == null)
                        ? "-"
                        : ((command.endTime == null)
                          ? formatDuration(Date.now() - command.startTime)
                          : formatDuration(command.endTime - command.startTime)
                        )
                      }
                    </p>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>



    // ========================================================================
    case ProcessStage.CONFIGURING:
      return <div className={styles.pageContainer}>
        <div className={styles.leftColumn}>
          <div className={styles.configTableContainer}>
            <table
              className={styles.table}
              onMouseLeave={() => setHighlightedCard(-1)}
            >
              {/* <thead>
                <tr>
                  <th>Badge</th>
                  <th>Card Name</th>
                  <th>Favorite</th>
                  <th>Reroll Position</th>
                </tr>
              </thead> */}
              <tbody>
                {mondoOptions.map((card, index) => (
                  <tr
                    key={index}
                    onMouseEnter={() => setHighlightedCard(index)}
                    className={`${index == highlightedCard ? styles.configHighlightedRow : ""}`}
                  >
                    <td className={styles.squareCell}>
                      <Image
                        src={card.icon}
                        alt={card.metadata.id}
                        title={`${FACTION_NAME[card.metadata.faction]} R${card.metadata.rarity}${card.metadata.alt ? " Alt Rare" : ""}`}
                        width={32}
                        height={32}
                      />
                    </td>
                    <td className={styles.longCell}>
                      <p title={card.metadata.name}>
                        {card.metadata.name}
                      </p>
                    </td>
                    <td className={styles.squareCell}>
                      <button
                        onClick={() => handleFavoriteChange(index)}
                        title={`Marks this ${card.metadata.name} as your favorite card, giving it a special display position`}
                      >
                        {card.favorite ? '❤️' : '♡'}
                      </button>
                    </td>
                    <td className={styles.squareCell}>
                      {card.favorite ? "" :
                        <button
                          onClick={() => rerollCardLocation(index)}
                          title={`Rerolls the position of this ${card.metadata.name}`}
                        >
                          ↻
                        </button>
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className={styles.rightColumn}>
        <div className={styles.configPreviewContainer}>
          <div className={styles.configPreviewImageWrapper}>
            <img
              src="/templates/picnic/bg_800x600.png"
                className={styles.configPreviewImage}
                style={{
                  zIndex: 0
                }}
                title="LAYOUT PREVIEW"
              />
              {mondoOptions.map((card, index) => (
                <img
                  key={index}
                  src="/cards/mm_74x125.png"
                  className={
                    `${card.favorite
                      ? `${styles.configPreviewFavoriteCard} ${styles.configPreviewTransparent}`
                      : styles.configPreviewCard} ${index == highlightedCard ? styles.configHighlightedCard : ""
                    }`
                  }
                  style={{
                    zIndex: card.favorite
                      ? mondoOptions.length + 2
                      : mondoOptions.length - index,
                    transform: card.favorite
                      ? `translate(-5px, -75px) rotate(-10deg)`
                      : `translate(${card.position.px()}px, ${card.position.py()}px) rotate(${card.position.rotation}deg)`,
                  }}
                  title="LAYOUT PREVIEW (cards will be rendered in full video in the final stage)"
                />
              ))}
              {mondoOptions.some(mondo => mondo.favorite) && (
                <div>
                  <img
                    src="/templates/picnic/h1_800x600.png"
                    className={`${styles.configPreviewImage} ${styles.configPreviewTransparent}`}
                    style={{
                      zIndex: mondoOptions.length + 1
                    }}
                  />
                  <img
                    src="/templates/picnic/h2_800x600.png"
                    className={`${styles.configPreviewImage} ${styles.configPreviewTransparent}`}
                    style={{
                      zIndex: mondoOptions.length + 3
                    }}
                    title="LAYOUT PREVIEW (transparency is simply for visibility in the draft stage)"
                  />
                </div>
              )}
            </div>
          </div>
          <div className={styles.configOptionsContainer}>
            <button
              onClick={() => rerollAllCardLocations()}
            >
              Reroll All Cards
            </button>
            <button
              onClick={() => generateFfmpegCommands()}
            >
              Generate Ffmpeg Commands
            </button>
          </div>
          <div className={styles.configSubmitContainer}>
            <button
              onClick={ffmpegStage == FfmpegStage.COMMANDED ? ()=>generateSpread() : ()=>{}}
            >
              Generate
            </button>
          </div>
        </div>
      </div>



    // ========================================================================
    case ProcessStage.START:
      return <div className={styles.pageContainer}>
        <div className={styles.startContainer}>
          <a href="https://www.mondomegabits.com/" target="_blank" rel="noopener noreferrer">
            <img src="/mondo_megabits.png" alt="Mondo Megabits" />
          </a>
          <p className={styles.startDescription}>
            Are you a <span className={styles.pulsingGreenText}>MONDO MAN</span>?
          </p>
          <p className={styles.startDescription}>
            I guess we'll find out...
          </p>
          <div className={styles.startInputContainer}>
            <input
              value={ethAddress}
              onChange={e => setEthAddress(e.target.value)}
            />
            <button onClick={initialize}>
              Begin
            </button>
          </div>
          <div className={styles.startLoadingZone}>
            {ffmpegStage == FfmpegStage.LOADING && (
              <div className={styles.startLoadingPair}>
                <img src="/icons/ffmpegwasm.png" className={styles.startLoadingIcon} />
                <img src="/icons/loading.gif" className={styles.startLoadingGif} />
              </div>
            )}
            {isLoadingNfts && (
              <div className={styles.startLoadingPair}>
                <img src="/icons/eth.png" className={styles.startLoadingIcon} />
                <img src="/icons/loading.gif" className={styles.startLoadingGif} />
              </div>
            )}
            {/* {isLoadingMondoAssets && (
              <div className={styles.startLoadingPair}>
                <img src="/icons/mondo.png" className={styles.startLoadingIcon} />
                <img src="/icons/loading.gif" className={styles.startLoadingGif} />
              </div>
            )} */}
          </div>
          <p className={styles.startErrorText}>{errorLoadingNfts}</p>
          <div className={styles.startAttribution}>
            <p>
              Wallet Spread Generator courtesy of <a href="https://www.scatter.art/mondo?tab=mint&ref=6524002954b1788a1a805e37">5crub.eth</a>
            </p>
            <div className={styles.startSocialsZone}>
              <a href="https://x.com/huge_scrub/" target="_blank" rel="noopener noreferrer">
                <img src="/icons/x.png" alt="X" />
              </a>
              <a href="https://github.com/5crub/" target="_blank" rel="noopener noreferrer">
                <img src="/icons/github.png" alt="GitHub" />
              </a>
            </div>
          </div>
        </div>
      </div>



    // ========================================================================
    default:
      return <div className={styles.pageContainer}>
        <p>
          THIS SHOULD NEVER BE VISIBLE!
        </p>
      </div>
  }
}
