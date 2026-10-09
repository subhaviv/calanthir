# syntax=docker/dockerfile:1
#
# ARM64, non-root container image for the Benefits Q&A agent.
# Listens on :8080, exposes /invocations and /ping per AgentCore Runtime contract.
# No credentials baked in — inference profile ARN and guardrail ID are injected
# at runtime via AgentCore Runtime environment variables.
#
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir --requirement /app/requirements.txt \
    && pip check

COPY benefits_qa_agent.py /app/benefits_qa_agent.py
COPY agent.py /app/agent.py
COPY prompts/system.txt /app/prompts/system.txt

USER 10001

EXPOSE 8080

ENTRYPOINT ["python", "-u", "agent.py"]
CMD []
