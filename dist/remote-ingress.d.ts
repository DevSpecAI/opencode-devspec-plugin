/**
 * Strict local consumer for the negotiated remote-ingress wire contract.
 * Operational policy and the authoritative schema live at
 * devspec://product/remote-ingress-contract.
 */
export declare const REMOTE_INGRESS_VERSION: 1;
export interface CanonicalAttachment {
    materialization: 'metadata' | 'unavailable';
    filename: string;
    mime_type: string;
    type: string;
    size_bytes: number | null;
    resource_id: string | null;
    reason?: 'missing_resource' | 'legacy_inline_payload' | 'access_denied';
}
export interface CanonicalOrder {
    sequence: number;
    created_at: string;
    message_id: string;
}
export interface CanonicalCommand {
    message_id: string;
    order: CanonicalOrder;
    content: {
        mode: 'full';
        body: string;
        complete: true;
    };
    attachments: CanonicalAttachment[];
    requester: {
        user_id: string;
        display_name: string | null;
    };
    authority: {
        kind: 'owner' | 'delegated';
        mode: 'owner' | 'project' | 'allowlist';
        requested_by_user_id: string;
        connection_owner_user_id: string;
        decision_source: 'server';
    };
    addressee: CanonicalConnection;
    delivery: {
        provenance_ref: string;
        turn_id: string;
        primary_provenance_ref: string;
        is_primary: boolean;
    };
}
export interface CanonicalConnection {
    connection_id: string;
    agent_name: string | null;
    codename: string | null;
    label: string;
}
export interface CanonicalContextEntry {
    message_id: string;
    order: CanonicalOrder;
    actor: {
        kind: 'human' | 'agent' | 'ai' | 'system';
        user_id: string | null;
        display_name: string;
        agent_tool: string | null;
        model: string | null;
    };
    source_type: string;
    relationship: 'before_window' | 'within_window' | 'after_command';
    content: string;
    advisory: true;
}
export interface CanonicalWindow {
    policy_version: string;
    returned: number;
    total_known: number | null;
    source_window: {
        start: CanonicalOrder | null;
        end: CanonicalOrder | null;
    };
    truncated: boolean;
    has_more: boolean;
    next_cursor: string | null;
    fetch_id: string | null;
    omission_reason: string | null;
}
export interface CanonicalIngress {
    kind: 'devspec.remote_ingress';
    schema_version: 1;
    contract_version: string;
    policy_version: string;
    envelope_id: string;
    connection: CanonicalConnection;
    wake: {
        kind: 'conversational_command' | 'control' | 'advisory_update' | 'history_reseed' | 'idle';
        active: boolean;
        reason_id: string;
    };
    delivery_state: 'live' | 'replay' | 'reseed';
    command_message_ids: string[];
    commands: CanonicalCommand[];
    control: unknown | null;
    context: {
        human_context: CanonicalContextEntry[];
        agent_context: CanonicalContextEntry[];
        ai_context: CanonicalContextEntry[];
        system_context: CanonicalContextEntry[];
    };
    window: CanonicalWindow;
}
export type CanonicalIngressResult = {
    ok: true;
    ingress: CanonicalIngress;
    executable: boolean;
} | {
    ok: false;
    error: string;
};
/** Parse a changed negotiated poll response. Missing ingress is therefore an error. */
export declare function parseCanonicalIngress(input: unknown, expectedConnectionId: string): CanonicalIngressResult;
export declare function selectCanonicalCommandsForPrompt(parsed: CanonicalIngressResult, deliveredMessageIds: ReadonlySet<string>): {
    commands: CanonicalCommand[];
    rejectedUnavailable: CanonicalCommand[];
};
export declare function freezeCanonicalTurn<T>(value: T): T;
