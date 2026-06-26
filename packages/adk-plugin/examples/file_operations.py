"""Example: Upload scripts and read output files.

This example demonstrates uploading Python and bash scripts to the sandbox,
executing them, and reading their output files.

Requirements:
    - DAYTONA_API_KEY environment variable set
    - GOOGLE_API_KEY environment variable set
"""

import asyncio
from google.adk.agents import Agent
from google.adk.runners import InMemoryRunner
from daytona_adk import DaytonaPlugin


async def main() -> None:
    """Upload and execute scripts, then read output files."""
    plugin = DaytonaPlugin()

    agent = Agent(
        model="gemini-2.0-flash",
        name="file_operations_agent",
        tools=plugin.get_tools(),
    )

    async with InMemoryRunner(
        app_name="file_operations_example",
        agent=agent,
        plugins=[plugin],
    ) as runner:
        # Upload and run Python script
        print("\n" + "=" * 60)
        print("Python Script Example")
        print("=" * 60)
        response = await runner.run_debug(
            """Upload a Python analysis script to /tmp/analysis.py with this code:
            import sys
            import os
            
            # Write analysis results to file
            with open('/tmp/analysis_output.txt', 'w') as f:
                f.write(f'Python Version: {sys.version}\\n')
                f.write(f'OS: {os.uname().sysname}\\n')
                f.write('Analysis complete!\\n')
            
            print('Analysis script executed successfully')
            
            Then execute the script and read the output file /tmp/analysis_output.txt"""
        )
        print(f"Response: {response}\n")

        # Upload and run bash script
        print("\n" + "=" * 60)
        print("Bash Script Example")
        print("=" * 60)
        response = await runner.run_debug(
            """Create a bash script at /tmp/system_info.sh with this content:
            #!/bin/bash
            echo "System Information Report" > /tmp/system_report.txt
            echo "========================" >> /tmp/system_report.txt
            echo "Hostname: $(hostname)" >> /tmp/system_report.txt
            echo "Date: $(date)" >> /tmp/system_report.txt
            echo "Disk Usage:" >> /tmp/system_report.txt
            df -h / >> /tmp/system_report.txt
            
            Then make it executable, run it, and show me the contents of /tmp/system_report.txt"""
        )
        print(f"Response: {response}\n")

    print("\nFile operations completed successfully!")


if __name__ == "__main__":
    asyncio.run(main())
