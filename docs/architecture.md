# Architecture

Dependency direction: core contracts are independent; task-engine depends on core; policy-engine depends on core; storage, platform, and models implement core contracts. Core does not depend on vendors, operating systems, UI frameworks, cloud services, or automation libraries.

Task state is changed only through `TaskEngine`. Actions are semantic and OS-independent. The Safety Kernel deterministically classifies and authorizes actions; model advice is never authoritative.
