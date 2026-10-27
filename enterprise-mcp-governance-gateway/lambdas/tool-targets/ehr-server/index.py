# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

"""AgentCore Gateway Lambda Target: EHR FHIR server.

Fronts the private HAPI FHIR EHR (internal ALB) with two governed tools:
  - ehr_fhir_lookup   : Patient demographics + recent Observations
  - imaging_lookup    : ImagingStudy resources for a patient

Runtime contract (AgentCore Lambda target), identical to database-server:
  - ``event`` is the FLAT tool-arguments dict (NOT a JSON-RPC envelope).
  - The invoked tool name is in
    ``context.client_context.custom['bedrockAgentCoreToolName']`` as
    ``EhrAPI___<tool_name>`` -- split on the triple underscore.
  - Return the MCP text-content result DIRECTLY.

The EHR base URL is injected as FHIR_BASE_URL. This Lambda is VPC-attached (in
the EHR private subnets + its gateway-tool SG) so it can reach the internal ALB.

PHI note: this returns real (synthetic) patient data; the gateway RESPONSE
interceptor + Bedrock Guardrail is the egress PHI control. Cedar on the gateway
restricts these tools to the clinical-staff group (see policies/ehr-*.cedar).
"""
import json
import os
import urllib.parse
import urllib.request
import urllib.error

FHIR_BASE = (os.environ.get("FHIR_BASE_URL", "") or "").rstrip("/")


def _text(text: str) -> dict:
    return {"content": [{"type": "text", "text": text}]}


def _resolve_tool_name(context) -> str:
    custom = {}
    client_context = getattr(context, "client_context", None)
    if client_context is not None:
        raw = getattr(client_context, "custom", None)
        if isinstance(raw, str):
            try:
                custom = json.loads(raw or "{}")
            except json.JSONDecodeError:
                custom = {}
        elif isinstance(raw, dict):
            custom = raw
    full = custom.get("bedrockAgentCoreToolName", "___unknown")
    return full.split("___", 1)[-1]


def _fhir_get(path: str):
    if not FHIR_BASE:
        raise RuntimeError("FHIR_BASE_URL is not configured")
    req = urllib.request.Request(
        FHIR_BASE + path,
        method="GET",
        headers={"Accept": "application/fhir+json"},
    )
    with urllib.request.urlopen(req, timeout=25) as resp:
        return json.loads(resp.read())


def _patient_name(patient: dict) -> str:
    names = patient.get("name") or []
    if not names:
        return ""
    n = names[0]
    return " ".join((n.get("given") or []) + [n.get("family", "")]).strip()


def handler(event, context):
    tool_name = _resolve_tool_name(context)
    args = event if isinstance(event, dict) else {}
    patient_id = str(args.get("patientId", "")).strip()

    if tool_name == "ehr_fhir_lookup":
        if not patient_id:
            return _text("ehr_fhir_lookup requires a patientId")
        try:
            patient = _fhir_get(f"/Patient/{urllib.parse.quote(patient_id)}")
            obs_bundle = _fhir_get(
                f"/Observation?patient={urllib.parse.quote(patient_id)}"
                "&_count=20&_sort=-date"
            )
            cond_bundle = _fhir_get(
                f"/Condition?patient={urllib.parse.quote(patient_id)}&_count=20"
            )
            med_bundle = _fhir_get(
                f"/MedicationRequest?patient={urllib.parse.quote(patient_id)}&_count=20"
            )
        except urllib.error.HTTPError as e:
            return _text(f"EHR lookup failed: HTTP {e.code} for patient {patient_id}")
        except Exception as e:  # noqa: BLE001
            return _text(f"EHR lookup error: {e}")
        observations = []
        for entry in (obs_bundle.get("entry") or []):
            r = entry.get("resource") or {}
            code = ((r.get("code") or {}).get("text")
                    or (((r.get("code") or {}).get("coding") or [{}])[0].get("display")))
            vq = r.get("valueQuantity") or {}
            value = (f"{vq.get('value')} {vq.get('unit', '')}".strip()
                     if vq else None)
            observations.append({
                "code": code,
                "value": value,
                "effective": r.get("effectiveDateTime"),
                "status": r.get("status"),
            })
        conditions = []
        for entry in (cond_bundle.get("entry") or []):
            r = entry.get("resource") or {}
            code = ((r.get("code") or {}).get("text")
                    or (((r.get("code") or {}).get("coding") or [{}])[0].get("display")))
            conditions.append({
                "code": code,
                "clinicalStatus": (((r.get("clinicalStatus") or {}).get("coding")
                                    or [{}])[0].get("code")),
                "onset": r.get("onsetDateTime"),
                "recorded": r.get("recordedDate"),
            })
        medications = []
        for entry in (med_bundle.get("entry") or []):
            r = entry.get("resource") or {}
            mcc = r.get("medicationCodeableConcept") or {}
            name = (mcc.get("text")
                    or ((mcc.get("coding") or [{}])[0].get("display")))
            medications.append({
                "medication": name,
                "status": r.get("status"),
                "intent": r.get("intent"),
                "authoredOn": r.get("authoredOn"),
            })
        result = {
            "patient": {
                "id": patient.get("id"),
                "name": _patient_name(patient),
                "gender": patient.get("gender"),
                "birthDate": patient.get("birthDate"),
            },
            "conditions": conditions,
            "medications": medications,
            "observations": observations,
        }
        return _text(json.dumps(result, indent=2))

    if tool_name == "imaging_lookup":
        if not patient_id:
            return _text("imaging_lookup requires a patientId")
        try:
            studies = _fhir_get(
                f"/ImagingStudy?patient={urllib.parse.quote(patient_id)}"
                "&_count=20&_sort=-started"
            )
        except urllib.error.HTTPError as e:
            return _text(f"Imaging lookup failed: HTTP {e.code} for patient {patient_id}")
        except Exception as e:  # noqa: BLE001
            return _text(f"Imaging lookup error: {e}")
        items = []
        for entry in (studies.get("entry") or []):
            r = entry.get("resource") or {}
            items.append({
                "id": r.get("id"),
                "status": r.get("status"),
                "started": r.get("started"),
                "modality": [m.get("code") for m in (r.get("modality") or [])],
                "numberOfSeries": r.get("numberOfSeries"),
                "numberOfInstances": r.get("numberOfInstances"),
                "description": r.get("description"),
            })
        return _text(json.dumps({"patientId": patient_id, "imagingStudies": items}, indent=2))

    return _text(f"Unknown tool: {tool_name}")
