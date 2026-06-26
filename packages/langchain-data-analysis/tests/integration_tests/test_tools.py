import os
from io import BytesIO
from typing import Type
from unittest.mock import Mock

import pytest  # type: ignore
from daytona import ExecuteResponse, ExecutionArtifacts  # type: ignore
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
        result = tool._run(code)
        assert isinstance(result, ExecutionArtifacts)
        assert "Integration test" in result.stdout or result.stdout == ""

        assert mock_on_result.called
        args, kwargs = mock_on_result.call_args
        result_arg = args[0]

        assert isinstance(result_arg, ExecutionArtifacts)
        assert "Integration test" in result_arg.stdout or result_arg.stdout == ""

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
