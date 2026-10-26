import os
from io import BytesIO
from typing import Type
from unittest.mock import Mock

import pytest  # type: ignore
from daytona import ExecuteResponse, ExecutionArtifacts  # type: ignore
from langchain_core.messages import ToolMessage
from langchain_tests.integration_tests import ToolsIntegrationTests  # type: ignore

from langchain_daytona_data_analysis.tools import (
    DaytonaDataAnalysisTool,
    SandboxUploadedFile,
    tool_base_description,
)


class TestDaytonaDataAnalysisToolIntegration(ToolsIntegrationTests):
    @property
    def tool_constructor(self) -> Type[DaytonaDataAnalysisTool]:
        return DaytonaDataAnalysisTool

    @property
    def tool_constructor_params(self) -> dict:
        return { 'daytona_api_key': os.environ.get('DAYTONA_API_KEY', ''),
                 'on_result': None}

    @property
    def tool_invoke_params_example(self) -> dict:
        return { 'data_analysis_python_code': "print('Hello World')"}

    def test_upload_and_download_file(self, tool: DaytonaDataAnalysisTool) -> None:
        file_content = b"test data"
        file_name = "test.txt"
        file_description = "Test file description"
        file_obj = BytesIO(file_content)
        file_obj.name = file_name

        uploaded_file = tool.upload_file(file_obj, description=file_description)
        
        assert isinstance(uploaded_file, SandboxUploadedFile)
        assert len(tool._sandbox_uploaded_files) == 1

        assert uploaded_file.name == file_name
        assert uploaded_file.description == file_description
        assert uploaded_file.remote_path.endswith(file_name)

        expected_description = tool_base_description + "\n" + tool._uploaded_files_description
        assert tool.description == expected_description 

        expected_uploaded_files_description = (
            "The following files available in the sandbox:\n"
            f"- path: `{uploaded_file.remote_path}` \n description: `{uploaded_file.description}`"
        )
        assert tool._uploaded_files_description == expected_uploaded_files_description 

        downloaded = tool.download_file(uploaded_file.remote_path)
        assert downloaded == file_content

    def test_remove_uploaded_file(self, tool: DaytonaDataAnalysisTool) -> None:
        file_content = b"to be removed"
        file_obj = BytesIO(file_content)
        file_obj.name = "remove.txt"

        uploaded_file = tool.upload_file(file_obj, description="Remove me")

        tool.remove_uploaded_file(uploaded_file)

        assert tool._sandbox_uploaded_files == []
        assert tool._uploaded_files_description == ""
        assert tool.description.rstrip() == tool_base_description.rstrip()

        with pytest.raises(Exception):
            tool.download_file(uploaded_file.remote_path)

    def test_run(self, tool: DaytonaDataAnalysisTool) -> None:
        mock_on_result = Mock()
        tool._on_result = mock_on_result

        code = "print('Integration test')"
        content, artifacts = tool._run(code)
        assert content == "Integration test"
        assert isinstance(artifacts, ExecutionArtifacts)
        assert "Integration test" in artifacts.stdout

        assert mock_on_result.called
        args, kwargs = mock_on_result.call_args
        result_arg = args[0]

        assert isinstance(result_arg, ExecutionArtifacts)
        assert "Integration test" in result_arg.stdout

    def test_chart_image_data_stays_out_of_tool_message(
        self, tool: DaytonaDataAnalysisTool
    ) -> None:
        code = (
            "import matplotlib.pyplot as plt\n"
            "import numpy as np\n"
            "rng = np.random.default_rng(0)\n"
            "plt.scatter(rng.random(50000), rng.random(50000), s=1)\n"
            "plt.title('50k points')\n"
            "plt.show()\n"
            "print('done')"
        )
        message = tool.invoke(
            {
                "args": {"data_analysis_python_code": code},
                "id": "1",
                "name": tool.name,
                "type": "tool_call",
            }
        )

        assert isinstance(message, ToolMessage)
        assert isinstance(message.content, str)
        assert message.content.startswith("done\n\nGenerated 1 chart(s).")
        assert message.content.endswith("- scatter: 50k points")
        assert isinstance(message.artifact, ExecutionArtifacts)
        assert message.artifact.charts and message.artifact.charts[0].png

    def test_close(self, tool: DaytonaDataAnalysisTool) -> None:
        try:
            tool.close()
        except Exception as e:
            pytest.fail(f"tool.close() raised an exception: {e}")
        assert tool._sandbox_uploaded_files == []

    def test_install_python_packages(self, tool: DaytonaDataAnalysisTool) -> None:
        package_name = "hello-world-py"
        tool.install_python_packages(package_name)
        response: ExecuteResponse = tool._sandbox.process.exec(f"pip show {package_name}")
        assert package_name in response.result
