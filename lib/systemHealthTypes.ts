export type HealthCheck = {
  name: string;
  ok: boolean;
  detail: string;
  checkedAt: string;
  latencyMs: number;
};

export type SupabaseKeyMeta = {
  present: boolean;
  normalizedLength: number;
  keyType: "jwt" | "secret_or_other";
  inferredRole: string | null;
  roleLooksValid: boolean;
};

export type SystemHealthReport = {
  generatedAt: string;
  overallOk: boolean;
  diagnosticsEnabled: boolean;
  environment: {
    nextPublicSupabaseUrl: boolean;
    appSessionSecret: boolean;
    studioMp3OverridesEnabled: boolean;
    supabaseServiceKey: SupabaseKeyMeta;
  };
  tables: HealthCheck[];
  improvements: {
    diagnosticsGate: "enabled" | "disabled";
    systemHealthApi: string;
    audioProbeMode: string;
    ciWorkflow: string;
    verifierCommand: string;
  };
};
