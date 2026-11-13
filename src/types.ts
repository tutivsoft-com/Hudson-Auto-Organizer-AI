import type { OrganizationPolicy } from "./organization-policy";
import type { Journal } from "./native-operations";

export interface MoveOperation {
  fromPath: string;
  toPath: string;
  kind?: "trash";
}

export interface MoveHistoryEntry {
  id: string;
  timestamp: number;
  instruction: string;
  moves: MoveOperation[];
  appends?: AppendOperation[];
  sourceEdits?: SourceEdit[];
  createdFolders?: string[];
  reportPath?: string;
  pendingMoves?: MoveOperation[];
  createdNotes?: CreatedNoteOperation[];
}

export interface SourceEdit { sourcePath: string; before: string; after: string; }

export interface CreatedNoteOperation { sourcePath: string; targetPath: string; text: string; undoTrashPath?: string; }

export interface AppendOperation {
  targetPath: string;
  sourcePath: string;
  text: string;
}

export interface LearnedMove {
  sourceFolder: string;
  destinationFolder: string;
  exampleName: string;
  count: number;
  updatedAt: number;
}

export interface AutoOrganizerSettings {
  organizationMode: "default" | "custom";
  organizationInstructions: string;
  organizationPolicy: OrganizationPolicy | null;
  organizationNeedsSetup: boolean;
  openRouterSecretName: string;
  debugLogging: boolean;
  model: string;
  aiProvider: "openai" | "openrouter";
  openaiModel: string;
  rulesFilePath: string;
  lineDestinationFolder: string;
  excludedFolders: string;
  learnFromMoves: boolean;
  sendNoteContent: boolean;
  learnedMoves: LearnedMove[];
  history: MoveHistoryEntry[];
  lastAutoOrganizeDeferred: Array<{ path: string; reason: string }>;
  lastAutoOrganizeReportPath: string;
  lastAutoOrganizeSourceFolder: string;
  settingsMode: "simple" | "advanced";
  organizeWorkflow: "preview" | "automatic";
  billingEmail: string;
  billingAccessToken: string;
  billingRefreshToken: string;
  billingAccessTokenExpiresAt: number;
  billingAccountLinked: boolean;
  freeUsesRemaining: number | null;
  purchasedUses: number | null;
  billingRegistrationPending: boolean;
  billingV2InstallationId: string;
  billingV2InstallationToken: string;
  billingV2InstallationOwner: string;
  billingV2Installations: Record<string, { id: string; token: string }>;
  constanceDeviceId: string;
  operationJournal: Journal[];
}

export const DEFAULT_SETTINGS: AutoOrganizerSettings = {
  organizationMode: "default",
  organizationInstructions: "",
  organizationPolicy: null,
  organizationNeedsSetup: false,
  openRouterSecretName: "",
  debugLogging: false,
  model: "~deepseek/deepseek-v4-flash-latest",
  aiProvider: "openrouter",
  openaiModel: "gpt-6-luna",
  rulesFilePath: "Auto Organizer Rules.md",
  lineDestinationFolder: "Projects, Areas, Resources",
  excludedFolders: "",
  learnFromMoves: false,
  sendNoteContent: false,
  learnedMoves: [],
  history: [],
  lastAutoOrganizeDeferred: [],
  lastAutoOrganizeReportPath: "",
  lastAutoOrganizeSourceFolder: "",
  settingsMode: "simple",
  organizeWorkflow: "preview",
  billingEmail: "",
  billingAccessToken: "",
  billingRefreshToken: "",
  billingAccessTokenExpiresAt: 0,
  billingAccountLinked: false,
  freeUsesRemaining: null,
  purchasedUses: null,
  billingRegistrationPending: false,
  billingV2InstallationId: "",
  billingV2InstallationToken: "",
  billingV2InstallationOwner: "",
  billingV2Installations: {},
  constanceDeviceId: "",
  operationJournal: []
};

export interface FolderRule {
  phrase: string;
  destination: string;
}
