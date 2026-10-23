"""The Docker host image Daytona builds for AgentEnv sandboxes."""

from agentenv_daytona.image import (
    DEFAULT_BASE_IMAGE,
    DOCKER_START_SCRIPT,
    HOST_IMAGE_VERSION,
    host_image,
)


def test_default_image_builds_on_daytona_sandbox_base_and_installs_docker_engine_and_compose() -> (
    None
):
    dockerfile = host_image().dockerfile()

    assert dockerfile.splitlines()[0] == f"FROM {DEFAULT_BASE_IMAGE}"
    for package in ("docker-ce", "docker-ce-cli", "containerd.io", "docker-compose-plugin"):
        assert package in dockerfile


def test_install_runs_as_root_and_the_image_ends_as_the_sudo_capable_daytona_user() -> None:
    lines = host_image().dockerfile().splitlines()

    assert lines[1] == "USER root"
    assert lines[-1] == "USER daytona"
    assert "daytona ALL=(ALL) NOPASSWD:ALL" in "\n".join(lines)


def test_docker_storage_is_left_empty_so_dockerd_prepares_it_at_boot() -> None:
    assert (
        "rm -rf /var/lib/apt/lists/* /var/lib/docker /var/lib/containerd"
        in host_image().dockerfile()
    )


def test_another_base_image_changes_only_the_from_line() -> None:
    default = host_image().dockerfile().splitlines()
    other = host_image("ubuntu:24.04").dockerfile().splitlines()

    assert other[0] == "FROM ubuntu:24.04"
    assert other[1:] == default[1:]


def test_recipe_is_one_layer_and_versioned() -> None:
    dockerfile = host_image().dockerfile()

    assert sum(line.startswith("RUN ") for line in dockerfile.splitlines()) == 1
    assert f"agentenv-host-image={HOST_IMAGE_VERSION}" in dockerfile


def test_docker_start_script_detaches_dockerd_and_skips_a_running_daemon() -> None:
    assert "setsid dockerd" in DOCKER_START_SCRIPT
    assert DOCKER_START_SCRIPT.startswith("pgrep -x dockerd >/dev/null ||")


def test_the_image_installs_procps_for_the_start_scripts_pgrep_on_slim_bases() -> None:
    assert "procps" in host_image().dockerfile()
