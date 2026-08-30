# INTRODUCTION :
a cli tool for POlaris AI that will encompass all the agents code and the LLM will be provided by the user for a BYOK solution. while the rest of the CLI is built with  the use of Typescript and we need to also ship a single agent-server that can be accessed via a TUI and also a web-page similar to what opencode does. 

## Architecture :
the goal is to build the CLI to use the agentic code we write with langgraph and be open to run our agents with any coding agent on the client's end. so we provide a single use agent MCP/CLI that can be used manually for the people to run things on their own or even run it on their harness to use something like claude-code or codex and so on with our MCP to run the agents but this time the models are frontier. 

## Tech Stack :
Typescript alone, we port all the agents we need from ../polaris/ 

## Phases: 
1 : build the CLI after importing all the agnetic context from polaris on top and just migrate all that lang-graph into typescript and write necessary manifests. while hanlding all the loop engineering because we need to ensure that the agents work locally. 

## Deployment (post building)


right we're gonna write a CLI tool that mimics what the polaris agents do. Also we need to use trueForge by all means.




