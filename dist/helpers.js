"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.readPrompt = readPrompt;
exports.parseJson = parseJson;
exports.truncate = truncate;
exports.quote = quote;
exports.isTrustedAssociation = isTrustedAssociation;
exports.errorMessage = errorMessage;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
function readPrompt(name) {
    return fs.readFileSync(path.join(__dirname, "prompts", name), "utf8").trim();
}
function parseJson(raw, label) {
    try {
        return JSON.parse(raw);
    }
    catch {
        const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fenced)
            return JSON.parse(fenced[1]);
        const start = raw.indexOf("{");
        const end = raw.lastIndexOf("}");
        if (start !== -1 && end > start) {
            return JSON.parse(raw.slice(start, end + 1));
        }
        throw new Error(`${label} is not JSON.`);
    }
}
function truncate(value, max = 2500) {
    const text = String(value ?? "").trim();
    return text.length <= max ? text : `${text.slice(0, max)}\n...[truncated]`;
}
function quote(value, max = 2500) {
    return truncate(value || "(no body)", max)
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
}
function isTrustedAssociation(value) {
    return typeof value === "string" && TRUSTED_ASSOCIATIONS.has(value);
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
