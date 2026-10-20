#!/usr/bin/env python3
"""
Generate 6 complete FHIR-native ER (Emergency Department) patient journeys as
transaction bundles, written into this directory as patient-er-*-bundle.json so
the EHR seeder (seed-rcm.sh) picks them up automatically.

Each journey is a time-ordered web of linked FHIR resources that a "patient
journey graph" is derived from:

    Encounter(EMER) -> Condition(presenting + final dx)
                    -> Observation(triage vitals + ESI acuity)
                    -> ServiceRequest -> DiagnosticReport (labs / imaging)
                    -> Procedure(s)
                    -> MedicationRequest(s)
                    -> Encounter.hospitalization (disposition)

All resources are .subject / .encounter linked and timestamped, so the journey
(arrival -> triage -> workup -> diagnosis -> treatment -> disposition) is a
connected graph. Fictional data only.

Usage:  python3 generate_er_patients.py
Output: patient-er-<slug>-bundle.json  (one per journey)
"""
from __future__ import annotations
import json, pathlib, datetime

OUT = pathlib.Path(__file__).parent
SNOMED = "http://snomed.info/sct"
LOINC = "http://loinc.org"
RXNORM = "http://www.nlm.nih.gov/research/umls/rxnorm"
ACT = "http://terminology.hl7.org/CodeSystem/v3-ActCode"
DCM = "http://dicom.nema.org/resources/ontology/DCM"


def iso(base: datetime.datetime, minutes: int) -> str:
    return (base + datetime.timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%SZ")


def vital(pid, enc, code, display, value, unit, ucum, when, comp=None):
    r = {
        "resourceType": "Observation",
        "status": "final",
        "category": [{"coding": [{"system": "http://terminology.hl7.org/CodeSystem/observation-category",
                                   "code": "vital-signs", "display": "Vital Signs"}]}],
        "code": {"coding": [{"system": LOINC, "code": code, "display": display}], "text": display},
        "subject": {"reference": f"Patient/{pid}"},
        "encounter": {"reference": f"Encounter/{enc}"},
        "effectiveDateTime": when,
    }
    if comp:
        r["component"] = comp
    else:
        r["valueQuantity"] = {"value": value, "unit": unit, "system": "http://unitsofmeasure.org", "code": ucum}
    return r


def lab(pid, enc, code, display, value, unit, ucum, when, interpretation=None):
    r = {
        "resourceType": "Observation",
        "status": "final",
        "category": [{"coding": [{"system": "http://terminology.hl7.org/CodeSystem/observation-category",
                                   "code": "laboratory", "display": "Laboratory"}]}],
        "code": {"coding": [{"system": LOINC, "code": code, "display": display}], "text": display},
        "subject": {"reference": f"Patient/{pid}"},
        "encounter": {"reference": f"Encounter/{enc}"},
        "effectiveDateTime": when,
        "valueQuantity": {"value": value, "unit": unit, "system": "http://unitsofmeasure.org", "code": ucum},
    }
    if interpretation:
        r["interpretation"] = [{"coding": [{"system": "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation",
                                            "code": interpretation}]}]
    return r


def make_journey(spec):
    pid = spec["pid"]
    enc = f"{pid}-enc"
    base = datetime.datetime.fromisoformat(spec["arrival"])
    resources = []

    # Patient
    resources.append({
        "resourceType": "Patient", "id": pid,
        "identifier": [{"system": "http://emed.example/mrn", "value": spec["mrn"]}],
        "name": [{"use": "official", "family": spec["family"], "given": [spec["given"]]}],
        "gender": spec["gender"], "birthDate": spec["birthDate"],
    })

    # Encounter (EMER) with triage + disposition
    resources.append({
        "resourceType": "Encounter", "id": enc,
        "status": "finished",
        "class": {"system": ACT, "code": "EMER", "display": "emergency"},
        "type": [{"coding": [{"system": SNOMED, "code": "50849002", "display": "Emergency room admission"}]}],
        "priority": {"coding": [{"system": SNOMED, "code": spec["acuity_snomed"], "display": spec["acuity_text"]}]},
        "subject": {"reference": f"Patient/{pid}"},
        "period": {"start": iso(base, 0), "end": iso(base, spec["los_min"])},
        "reasonCode": [{"text": spec["chief_complaint"]}],
        "hospitalization": {"dischargeDisposition": {"coding": [{
            "system": "http://terminology.hl7.org/CodeSystem/discharge-disposition",
            "code": spec["disposition_code"], "display": spec["disposition_text"]}]}},
    })

    # Presenting + final conditions
    resources.append({
        "resourceType": "Condition", "id": f"{pid}-cc",
        "clinicalStatus": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/condition-clinical", "code": "active"}]},
        "category": [{"coding": [{"system": "http://terminology.hl7.org/CodeSystem/condition-category",
                                  "code": "encounter-diagnosis", "display": "Encounter Diagnosis"}]}],
        "code": {"coding": [{"system": SNOMED, "code": spec["cc_snomed"], "display": spec["chief_complaint"]}],
                 "text": spec["chief_complaint"]},
        "subject": {"reference": f"Patient/{pid}"},
        "encounter": {"reference": f"Encounter/{enc}"},
        "onsetDateTime": iso(base, -spec.get("onset_before_min", 120)),
    })
    resources.append({
        "resourceType": "Condition", "id": f"{pid}-dx",
        "clinicalStatus": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/condition-clinical", "code": "active"}]},
        "verificationStatus": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/condition-ver-status", "code": "confirmed"}]},
        "category": [{"coding": [{"system": "http://terminology.hl7.org/CodeSystem/condition-category",
                                  "code": "encounter-diagnosis", "display": "Encounter Diagnosis"}]}],
        "code": {"coding": [{"system": SNOMED, "code": spec["dx_snomed"], "display": spec["final_dx"]}],
                 "text": spec["final_dx"]},
        "subject": {"reference": f"Patient/{pid}"},
        "encounter": {"reference": f"Encounter/{enc}"},
        "recordedDate": iso(base, spec.get("dx_min", 90)),
    })

    # Triage vitals (at ~ +10 min)
    t = spec.get("triage_min", 10)
    tv = [
        vital(pid, enc, "8867-4", "Heart rate", spec["hr"], "beats/min", "/min", iso(base, t)),
        vital(pid, enc, "9279-1", "Respiratory rate", spec["rr"], "breaths/min", "/min", iso(base, t)),
        vital(pid, enc, "59408-5", "Oxygen saturation", spec["spo2"], "%", "%", iso(base, t)),
        vital(pid, enc, "8310-5", "Body temperature", spec["temp"], "Cel", "Cel", iso(base, t)),
        vital(pid, enc, "85354-9", "Blood pressure", None, None, None, iso(base, t), comp=[
            {"code": {"coding": [{"system": LOINC, "code": "8480-6", "display": "Systolic"}]},
             "valueQuantity": {"value": spec["sbp"], "unit": "mmHg", "system": "http://unitsofmeasure.org", "code": "mm[Hg]"}},
            {"code": {"coding": [{"system": LOINC, "code": "8462-4", "display": "Diastolic"}]},
             "valueQuantity": {"value": spec["dbp"], "unit": "mmHg", "system": "http://unitsofmeasure.org", "code": "mm[Hg]"}},
        ]),
    ]
    for k, v in enumerate(tv):
        v["id"] = f"{pid}-vital-{k}"
        resources.append(v)

    # Labs + imaging (ServiceRequest -> DiagnosticReport), workup phase
    result_refs = []
    for i, w in enumerate(spec.get("workup", [])):
        sr_id = f"{pid}-sr-{i}"
        resources.append({
            "resourceType": "ServiceRequest", "id": sr_id,
            "status": "completed", "intent": "order",
            "code": {"coding": [{"system": w["system"], "code": w["code"], "display": w["display"]}], "text": w["display"]},
            "subject": {"reference": f"Patient/{pid}"},
            "encounter": {"reference": f"Encounter/{enc}"},
            "authoredOn": iso(base, w.get("ordered_min", 30)),
        })
        obs_ids = []
        for j, obs in enumerate(w.get("results", [])):
            oid = f"{pid}-lab-{i}-{j}"
            resources.append({**lab(pid, enc, obs["code"], obs["display"], obs["value"], obs["unit"],
                                    obs["ucum"], iso(base, w.get("result_min", 60)), obs.get("interp")),
                              "id": oid})
            obs_ids.append({"reference": f"Observation/{oid}"})
        dr_id = f"{pid}-dr-{i}"
        dr = {
            "resourceType": "DiagnosticReport", "id": dr_id,
            "status": "final",
            "code": {"coding": [{"system": w["system"], "code": w["code"], "display": w["display"]}], "text": w["display"]},
            "subject": {"reference": f"Patient/{pid}"},
            "encounter": {"reference": f"Encounter/{enc}"},
            "effectiveDateTime": iso(base, w.get("result_min", 60)),
            "issued": iso(base, w.get("result_min", 60)),
            "basedOn": [{"reference": f"ServiceRequest/{sr_id}"}],
            "conclusion": w.get("impression", ""),
        }
        if obs_ids:
            dr["result"] = obs_ids
        if w.get("imaging"):
            img_id = f"{pid}-img-{i}"
            resources.append({
                "resourceType": "ImagingStudy", "id": img_id,
                "status": "available",
                "subject": {"reference": f"Patient/{pid}"},
                "encounter": {"reference": f"Encounter/{enc}"},
                "started": iso(base, w.get("result_min", 60)),
                "numberOfSeries": w["imaging"].get("series", 1),
                "numberOfInstances": w["imaging"].get("instances", 40),
                "modality": [{"system": DCM, "code": w["imaging"]["modality"]}],
                "description": w["display"],
            })
            dr["imagingStudy"] = [{"reference": f"ImagingStudy/{img_id}"}]
        resources.append(dr)
        result_refs.append(dr_id)

    # Procedures (treatment phase)
    for i, p in enumerate(spec.get("procedures", [])):
        resources.append({
            "resourceType": "Procedure", "id": f"{pid}-proc-{i}",
            "status": "completed",
            "code": {"coding": [{"system": SNOMED, "code": p["code"], "display": p["display"]}], "text": p["display"]},
            "subject": {"reference": f"Patient/{pid}"},
            "encounter": {"reference": f"Encounter/{enc}"},
            "performedDateTime": iso(base, p.get("min", 75)),
        })

    # Medications (treatment phase)
    for i, m in enumerate(spec.get("meds", [])):
        resources.append({
            "resourceType": "MedicationRequest", "id": f"{pid}-med-{i}",
            "status": "completed", "intent": "order",
            "medicationCodeableConcept": {"coding": [{"system": RXNORM, "code": m["code"], "display": m["display"]}],
                                          "text": m["display"]},
            "subject": {"reference": f"Patient/{pid}"},
            "encounter": {"reference": f"Encounter/{enc}"},
            "authoredOn": iso(base, m.get("min", 80)),
            "dosageInstruction": [{"text": m["dose"]}],
        })

    entries = [{"resource": r, "request": {"method": "PUT", "url": f"{r['resourceType']}/{r['id']}"}} for r in resources]
    return {"resourceType": "Bundle", "type": "transaction", "entry": entries}


JOURNEYS = [
    {
        "pid": "halo-er-chestpain", "mrn": "ER-20001", "family": "Alvarez", "given": "Carlos",
        "gender": "male", "birthDate": "1968-02-14", "arrival": "2026-10-14T06:20:00",
        "chief_complaint": "Central chest pain radiating to left arm",
        "cc_snomed": "29857009", "final_dx": "Acute ST-elevation myocardial infarction",
        "dx_snomed": "401303003", "acuity_snomed": "25876001", "acuity_text": "Emergency",
        "hr": 104, "rr": 22, "spo2": 94, "temp": 36.8, "sbp": 158, "dbp": 96, "los_min": 95,
        "disposition_code": "other-hcf", "disposition_text": "Admitted to cardiac cath lab",
        "workup": [
            {"system": LOINC, "code": "6598-7", "display": "Troponin T", "ordered_min": 20, "result_min": 45,
             "impression": "Elevated troponin consistent with acute MI",
             "results": [{"code": "6598-7", "display": "Troponin T", "value": 2.4, "unit": "ng/mL", "ucum": "ng/mL", "interp": "H"}]},
            {"system": LOINC, "code": "11524-6", "display": "12-lead ECG", "ordered_min": 15, "result_min": 25,
             "impression": "ST elevation in leads II, III, aVF - inferior STEMI", "results": []},
        ],
        "procedures": [{"code": "41976001", "display": "Continuous ECG monitoring", "min": 30},
                       {"code": "392230005", "display": "Insertion of peripheral IV cannula", "min": 22}],
        "meds": [{"code": "1191", "display": "Aspirin 324 mg PO", "dose": "324 mg chewed once", "min": 28},
                 {"code": "5640", "display": "Heparin IV bolus", "dose": "60 units/kg IV bolus", "min": 40}],
    },
    {
        "pid": "halo-er-sepsis", "mrn": "ER-20002", "family": "Nakamura", "given": "Yuki",
        "gender": "female", "birthDate": "1954-09-02", "arrival": "2026-10-15T14:05:00",
        "chief_complaint": "Fever, confusion, and low blood pressure",
        "cc_snomed": "386661006", "final_dx": "Sepsis due to urinary tract infection",
        "dx_snomed": "91302008", "acuity_snomed": "25876001", "acuity_text": "Emergency",
        "hr": 122, "rr": 26, "spo2": 91, "temp": 39.4, "sbp": 86, "dbp": 52, "los_min": 180,
        "disposition_code": "other-hcf", "disposition_text": "Admitted to ICU",
        "workup": [
            {"system": LOINC, "code": "1975-2", "display": "Lactate", "ordered_min": 15, "result_min": 40,
             "impression": "Elevated lactate - tissue hypoperfusion",
             "results": [{"code": "1975-2", "display": "Lactate", "value": 4.1, "unit": "mmol/L", "ucum": "mmol/L", "interp": "H"}]},
            {"system": LOINC, "code": "6690-2", "display": "White blood cell count", "ordered_min": 15, "result_min": 42,
             "impression": "Leukocytosis",
             "results": [{"code": "6690-2", "display": "WBC", "value": 18.6, "unit": "10*3/uL", "ucum": "10*3/uL", "interp": "H"}]},
            {"system": LOINC, "code": "630-4", "display": "Urine culture", "ordered_min": 25, "result_min": 90,
             "impression": "Gram-negative rods - E. coli suspected", "results": []},
        ],
        "procedures": [{"code": "392230005", "display": "Insertion of peripheral IV cannula", "min": 18},
                       {"code": "34121006", "display": "Urinary catheterization", "min": 35}],
        "meds": [{"code": "723", "display": "Piperacillin-tazobactam IV", "dose": "4.5 g IV q6h", "min": 50},
                 {"code": "9863", "display": "Sodium chloride 0.9% IV", "dose": "30 mL/kg bolus", "min": 20}],
    },
    {
        "pid": "halo-er-stroke", "mrn": "ER-20003", "family": "Oyelaran", "given": "Ade",
        "gender": "male", "birthDate": "1961-07-19", "arrival": "2026-10-16T09:48:00",
        "chief_complaint": "Sudden left-sided weakness and slurred speech",
        "cc_snomed": "44077006", "final_dx": "Acute ischemic stroke",
        "dx_snomed": "422504002", "acuity_snomed": "25876001", "acuity_text": "Emergency",
        "hr": 88, "rr": 18, "spo2": 97, "temp": 36.9, "sbp": 176, "dbp": 98, "los_min": 140,
        "disposition_code": "other-hcf", "disposition_text": "Admitted to stroke unit",
        "workup": [
            {"system": LOINC, "code": "24725-4", "display": "CT head without contrast", "ordered_min": 10, "result_min": 35,
             "impression": "No hemorrhage; early ischemic changes right MCA territory",
             "imaging": {"modality": "CT", "series": 2, "instances": 180}, "results": []},
            {"system": LOINC, "code": "14979-9", "display": "INR", "ordered_min": 12, "result_min": 38,
             "impression": "Normal coagulation - eligible for thrombolysis",
             "results": [{"code": "14979-9", "display": "INR", "value": 1.0, "unit": "{ratio}", "ucum": "{ratio}"}]},
        ],
        "procedures": [{"code": "392230005", "display": "Insertion of peripheral IV cannula", "min": 15}],
        "meds": [{"code": "8410", "display": "Alteplase (tPA) IV", "dose": "0.9 mg/kg IV (max 90 mg)", "min": 55}],
    },
    {
        "pid": "halo-er-mva", "mrn": "ER-20004", "family": "Petrova", "given": "Irina",
        "gender": "female", "birthDate": "1995-12-30", "arrival": "2026-10-16T21:10:00",
        "chief_complaint": "Motor vehicle collision, abdominal and chest trauma",
        "cc_snomed": "418399005", "final_dx": "Splenic laceration with hemoperitoneum",
        "dx_snomed": "262946009", "acuity_snomed": "25876001", "acuity_text": "Emergency",
        "hr": 118, "rr": 24, "spo2": 95, "temp": 36.5, "sbp": 102, "dbp": 64, "los_min": 160,
        "disposition_code": "other-hcf", "disposition_text": "Admitted to trauma surgery",
        "workup": [
            {"system": LOINC, "code": "42274-4", "display": "CT abdomen/pelvis with contrast", "ordered_min": 20, "result_min": 55,
             "impression": "Grade III splenic laceration with moderate hemoperitoneum",
             "imaging": {"modality": "CT", "series": 3, "instances": 320}, "results": []},
            {"system": LOINC, "code": "718-7", "display": "Hemoglobin", "ordered_min": 15, "result_min": 40,
             "impression": "Dropping hemoglobin - active bleeding",
             "results": [{"code": "718-7", "display": "Hemoglobin", "value": 9.1, "unit": "g/dL", "ucum": "g/dL", "interp": "L"}]},
        ],
        "procedures": [{"code": "392230005", "display": "Insertion of peripheral IV cannula", "min": 12},
                       {"code": "70536003", "display": "Transfusion of blood product", "min": 70}],
        "meds": [{"code": "9863", "display": "Sodium chloride 0.9% IV", "dose": "1 L bolus", "min": 18}],
    },
    {
        "pid": "halo-er-asthma", "mrn": "ER-20005", "family": "Diallo", "given": "Fatou",
        "gender": "female", "birthDate": "2014-05-21", "arrival": "2026-10-17T19:30:00",
        "chief_complaint": "Pediatric acute shortness of breath and wheezing",
        "cc_snomed": "267036007", "final_dx": "Acute asthma exacerbation",
        "dx_snomed": "708038006", "acuity_snomed": "103391001", "acuity_text": "Urgent",
        "hr": 134, "rr": 36, "spo2": 89, "temp": 37.1, "sbp": 108, "dbp": 70, "los_min": 150,
        "disposition_code": "home", "disposition_text": "Discharged home - improved",
        "workup": [
            {"system": LOINC, "code": "19868-9", "display": "Chest X-ray", "ordered_min": 25, "result_min": 50,
             "impression": "Hyperinflation, no focal consolidation",
             "imaging": {"modality": "CR", "series": 1, "instances": 2}, "results": []},
            {"system": LOINC, "code": "33452-4", "display": "Peak expiratory flow", "ordered_min": 10, "result_min": 15,
             "impression": "Reduced PEF, improved post-bronchodilator",
             "results": [{"code": "33452-4", "display": "Peak expiratory flow", "value": 180, "unit": "L/min", "ucum": "L/min", "interp": "L"}]},
        ],
        "procedures": [{"code": "57485005", "display": "Oxygen administration by nasal cannula", "min": 12}],
        "meds": [{"code": "435", "display": "Albuterol nebulizer", "dose": "2.5 mg neb q20min x3", "min": 15},
                 {"code": "8640", "display": "Prednisolone PO", "dose": "1 mg/kg PO once", "min": 40}],
    },
    {
        "pid": "halo-er-abdpain", "mrn": "ER-20006", "family": "Haddad", "given": "Samir",
        "gender": "male", "birthDate": "1989-03-08", "arrival": "2026-10-18T11:55:00",
        "chief_complaint": "Right lower quadrant abdominal pain",
        "cc_snomed": "102594003", "final_dx": "Acute appendicitis",
        "dx_snomed": "85189001", "acuity_snomed": "103391001", "acuity_text": "Urgent",
        "hr": 98, "rr": 18, "spo2": 98, "temp": 38.1, "sbp": 128, "dbp": 78, "los_min": 130,
        "disposition_code": "other-hcf", "disposition_text": "Admitted for appendectomy",
        "workup": [
            {"system": LOINC, "code": "42274-4", "display": "CT abdomen/pelvis with contrast", "ordered_min": 30, "result_min": 70,
             "impression": "Dilated appendix with periappendiceal fat stranding - acute appendicitis",
             "imaging": {"modality": "CT", "series": 2, "instances": 240}, "results": []},
            {"system": LOINC, "code": "6690-2", "display": "White blood cell count", "ordered_min": 20, "result_min": 45,
             "impression": "Leukocytosis",
             "results": [{"code": "6690-2", "display": "WBC", "value": 14.2, "unit": "10*3/uL", "ucum": "10*3/uL", "interp": "H"}]},
        ],
        "procedures": [{"code": "392230005", "display": "Insertion of peripheral IV cannula", "min": 25}],
        "meds": [{"code": "7980", "display": "Ceftriaxone IV", "dose": "2 g IV once", "min": 60},
                 {"code": "6813", "display": "Morphine IV", "dose": "4 mg IV q4h PRN", "min": 35}],
    },
]


def main():
    for spec in JOURNEYS:
        bundle = make_journey(spec)
        out = OUT / f"patient-{spec['pid']}-bundle.json"
        out.write_text(json.dumps(bundle, indent=2))
        n = len(bundle["entry"])
        print(f"  wrote {out.name}  ({n} resources)  {spec['given']} {spec['family']} - {spec['final_dx']}")


if __name__ == "__main__":
    main()
