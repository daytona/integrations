import ast
import os
from io import StringIO
from sys import version_info
from typing import IO, Any, Callable, List, Optional, Type, Union

from daytona import (  # type: ignore
    Daytona,
    DaytonaConfig,
    ExecutionArtifacts,
    Sandbox,
)
from langchain_core.callbacks import (  # type: ignore
    CallbackManagerForToolRun,
)
from langchain_core.tools import BaseTool  # type: ignore
from pydantic import BaseModel, Field, PrivateAttr  # type: ignore

from .unparse import Unparser  # type: ignore


class DaytonaDataAnalysisToolInput(BaseModel):
    """Input schema for DaytonaDataAnalysisTool."""

    data_analysis_python_code: str = Field(...,         
        examples=["print('Hello World')"],
        description=(
            "The python script to be evaluated. "
            "The contents will be in main.py. "
            "It should not be in markdown format."
        ),)

class SandboxUploadedFile(BaseModel):
    """Description of the uploaded file with its remote path."""
    name: str
    remote_path: str
    description: str

tool_base_description = """Tool for running python code in a sandboxed environment for data analysis. \
The environment is long running and exists across multiple executions. \
You must send the whole script every time and print your outputs. \
Script should be pure python code that can be evaluated. \
It should be in python format NOT markdown. \
The code should NOT be wrapped in backticks. \
All python packages including requests, matplotlib, scipy, numpy, pandas, seaborn \
etc are available. Create and display chart using `plt.show()`."""

class DaytonaDataAnalysisTool(BaseTool):  # type: ignore[override]
    """Tool for running python code in a sandboxed environment for data analysis.


     Setup:
          Install ``daytona`` and set credentials for Daytona:


          1. Set the environment variable:
              .. code-block:: bash

                  export DAYTONA_API_KEY="your-api-key"

          2. Or, add it to a `.env` file in your project root:
              .. code-block:: bash

                  DAYTONA_API_KEY=your-api-key

          3. Or, pass it directly as a parameter:
              .. code-block:: python

                  tool = DaytonaDataAnalysisTool(daytona_api_key="your-api-key")

          Then install the package:
              .. code-block:: bash

                  pip install -U daytona


    Key init args:
        daytona_api_key: Optional[str]
            Daytona API key. Not required if API key is set via env variable.
        on_result: Optional[Callable[[ExecutionArtifacts], Any]]
            Method which specifies actions to do with a result of data analysis.
            Receives one argument of type ExecutionArtifacts.
            ExecutionArtifacts attributes:
                stdout (str): Standard output from the command
                charts (Optional[List[Chart]]): List of chart metadata from matplotlib


    Instantiation:
        .. code-block:: python

            from daytona_data_analysis_tool import DaytonaDataAnalysisTool
            tool = DaytonaDataAnalysisTool(
                # daytona_api_key="...",
                # on_result="..."
            )

    Invocation with args:
        .. code-block:: python

            tool.invoke({'data_analysis_python_code': "print('Hello World')"})

        .. code-block:: python

            { "stdout": "Hello World\n", "charts": [] }

    Invocation with ToolCall:

        .. code-block:: python

            tool.invoke({"args": {'data_analysis_python_code': "print('Hello World')"}, "id": "1", "name": "daytona_data_analysis", "type": "tool_call"})

        .. code-block:: python

            ToolMessage(content='{ "stdout": "Hello World\n", "charts": [] }', name='daytona_data_analysis', tool_call_id='1')

    """  # noqa: E501

    name: str = "daytona_data_analysis"
    description: str = tool_base_description
    args_schema: Type[BaseModel] = DaytonaDataAnalysisToolInput

    _daytonaClient: Daytona = PrivateAttr()
    _sandbox: Sandbox = PrivateAttr()
    _sandbox_uploaded_files: List[SandboxUploadedFile] = PrivateAttr(default_factory=list)
    _on_result = PrivateAttr()

    @property
    def _uploaded_files_description(self) -> str:
        if len(self._sandbox_uploaded_files) == 0:
            return ""
        lines = ["The following files available in the sandbox:"]

        for f in self._sandbox_uploaded_files:
            if f.description == "":
                lines.append(f"- path: `{f.remote_path}`")
            else:
                lines.append(
                    f"- path: `{f.remote_path}` \n description: `{f.description}`"
                )
        return "\n".join(lines)
    
    def __init__(
        self,
        daytona_api_key: Optional[str] = None,
        on_result: Optional[Callable[[ExecutionArtifacts], Any]] = None,
        **kwargs: Any,
    ):
        try:
            from daytona import Daytona
        except ImportError as e:
            raise ImportError(
                "Unable to import daytona, please install with `pip install daytona`."
            ) from e

        super().__init__(description=tool_base_description, **kwargs)
        daytona_api_key = daytona_api_key or os.environ.get("DAYTONA_API_KEY")
        self._daytonaClient = Daytona(DaytonaConfig(api_key=daytona_api_key))
        self._sandbox = self._daytonaClient.create()
        self._on_result = on_result

    def _run(
        self, data_analysis_python_code: str, run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str | ExecutionArtifacts:
        python_code_to_exec = self._add_last_line_print(data_analysis_python_code)

        execution = self._sandbox.process.code_run(python_code_to_exec)
        if execution.exit_code != 0:
            return 'Python code execution code exited with code ' + execution.exit_code + "\n" + "Result: " + execution.result

        if self._on_result is not None:
            if not execution.artifacts:
                return "Python code execution didn't generate any artifacts"
            else:
                self._on_result(execution.artifacts)
                return execution.artifacts
        else: 
            return execution.artifacts
    
    def close(self) -> None:
        """Close and delete sandbox."""
        self._sandbox_uploaded_files = []
        self._daytonaClient.delete(self._sandbox)

    def install_python_packages(self, package_names: Union[str, List[str]]) -> None:
        """Install python packages in the sandbox."""
        if isinstance(package_names, str):
            packages_str = package_names
        else:
            packages_str = " ".join(package_names)
        command = f"pip install {packages_str}"
        self._sandbox.process.exec(command)

    def download_file(self, remote_path: str) -> bytes:
        """Download file from the sandbox."""
        return self._sandbox.fs.download_file(remote_path)

    def upload_file(self, file: IO, description: str) -> SandboxUploadedFile:
        """Upload file to the sandbox.

        The file is uploaded to the '/home/daytona' path."""

        fileName = os.path.basename(file.name)
        fileRemotePath = "/home/daytona/" + fileName
        file_bytes = file.read()
        self._sandbox.fs.upload_file(file_bytes, fileRemotePath)

        sandboxFile = SandboxUploadedFile(
            name=os.path.basename(file.name),
            remote_path=fileRemotePath,
            description=description,
        )
        self._sandbox_uploaded_files.append(sandboxFile)
        self.description = tool_base_description + "\n" + self._uploaded_files_description
        return sandboxFile

    def remove_uploaded_file(self, uploaded_file: SandboxUploadedFile) -> None:
        """Remove uploaded file from the sandbox."""
        self._sandbox.fs.delete_file(uploaded_file.remote_path)
        self._sandbox_uploaded_files = [
            f
            for f in self._sandbox_uploaded_files
            if f.remote_path != uploaded_file.remote_path
        ]
        self.description = tool_base_description + "\n" + self._uploaded_files_description

    def get_sandbox(self) -> Sandbox:
        """Get the current sandbox instance."""
        return self._daytonaClient.get(self._sandbox.id)
    
    def _unparse(self, tree: ast.AST) -> str:
        """Unparse the AST."""
        if version_info.minor < 9:
            s = StringIO()
            Unparser(tree, file=s)
            source_code = s.getvalue()
            s.close()
        else:
            source_code = ast.unparse(tree)
        return source_code
    
    def _add_last_line_print(self, code: str) -> str:
        """Add print statement to the last line if it's missing.

        Sometimes, the LLM-generated code doesn't have `print(variable_name)`, instead the
            LLM tries to print the variable only by writing `variable_name` (as you would in
            REPL, for example).

        This methods checks the AST of the generated Python code and adds the print
            statement to the last line if it's missing.
        """
        tree = ast.parse(code)
        node = tree.body[-1]
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
            if isinstance(node.value.func, ast.Name) and node.value.func.id == "print":
                return self._unparse(tree)

        if isinstance(node, ast.Expr):
            tree.body[-1] = ast.Expr(
                value=ast.Call(
                    func=ast.Name(id="print", ctx=ast.Load()),
                    args=[node.value],
                    keywords=[],
                )
            )

        return self._unparse(tree)
