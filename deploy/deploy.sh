dir=$(dirname $(realpath $0))

IMAGE_TAG="latest"

export DOCKER_REGISTRY="854153369854.dkr.ecr.ap-southeast-1.amazonaws.com"
export PROJECT_DIR=$dir/..

function ecr-auth() {
    aws ecr get-login-password --region ap-southeast-1 | docker login --username AWS --password-stdin $DOCKER_REGISTRY
}

function build() {
    docker build -f $PROJECT_DIR/Dockerfile -t $DOCKER_REGISTRY/port-liquidator:$IMAGE_TAG $PROJECT_DIR/
}

function push() {
    build $1 && ecr-auth && docker push $DOCKER_REGISTRY/port-liquidator:$IMAGE_TAG
}

function apply() {
    sed -i 's@$HOME@'$HOME'@g' kustomization.yaml
    kustomize build --load-restrictor LoadRestrictionsNone . |  kubectl apply -f -
    sed -i 's@'$HOME'@$HOME@g' kustomization.yaml
}

case "$1" in
    "apply")
        apply
        ;;
    "build")
        build $2
        ;;
    "push")
        push $2
        ;;
    "ecr-auth")
        ecr-auth
        ;;
    *)
        echo "supported param: "
        echo "                1) apply"
        echo "                2) build"
        echo "                3) push"
        echo "                5) ecr-auth"
        ;;
esac